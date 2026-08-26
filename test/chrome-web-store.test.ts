import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
// The production helper is intentionally plain Node ESM so Actions can run it
// without installing dependencies.
const chromeWebStore =
  // @ts-expect-error The JavaScript CLI does not ship a TypeScript declaration.
  await import('../scripts/chrome-web-store.mjs');
const {
  EXPECTED_EXTENSION_ID,
  EXPECTED_OWNER_ID,
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_ID,
  PUBLISH_REQUEST,
  claimSubmitAttempt,
  claimUploadAttempt,
  claimPublishAttempt,
  compareZipToDirectory,
  compareChromeVersions,
  decidePublishAction,
  decideSubmitAction,
  deriveExtensionId,
  fetchStoreStatus,
  formatAttemptMarker,
  formatRolloutLedgerMarker,
  parseChromeVersion,
  parseReleaseTag,
  parseZipFiles,
  planStorePublish,
  planStoreSubmit,
  planStoreUpload,
  publishToStore,
  recordUploadSuccess,
  requireManualPublishTag,
  requirePublishConfirmation,
  requireSubmitConfirmation,
  requireUploadConfirmation,
  submitDraftForReview,
  uploadDraftToStore,
  validateManifest,
  validateAttemptMarker,
  validateRolloutLedgerMarker,
  validatePublisherId,
  validateReleaseEvent,
  validateReleaseRecord,
  verifyUploadLedgers,
  verifyItemIdentity,
} = chromeWebStore;

const PUBLISHER_ID = '00000000-0000-4000-8000-000000000000';
const name = `publishers/${PUBLISHER_ID}/items/${EXPECTED_EXTENSION_ID}`;
const statusUrl = `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`;
const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`;
const publishUrl = `https://chromewebstore.googleapis.com/v2/${name}:publish`;
const EXPECTED_PUBLISH_REQUEST = { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true };
const deriveExpectedId = () => EXPECTED_EXTENSION_ID;
const ATTEMPT = {
  repository: EXPECTED_REPOSITORY,
  tag: 'v0.3.0',
  version: '0.3.0',
  releaseId: 375937330,
  assetId: 528076253,
  commit: '1'.repeat(40),
  sha256: '2'.repeat(64),
  runUrl: `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/123456`,
};
const ROLLOUT = {
  repository: EXPECTED_REPOSITORY,
  repositoryId: EXPECTED_REPOSITORY_ID,
  tag: 'v0.3.0',
  version: '0.3.0',
  releaseId: 375937330,
  assetId: 528076253,
  assetName: 'eipeek-0.3.0-chrome.zip',
  assetSize: 151532,
  tagObject: '3'.repeat(40),
  commit: '1'.repeat(40),
  sha256: '2'.repeat(64),
  publisherId: PUBLISHER_ID,
  extensionId: EXPECTED_EXTENSION_ID,
  runId: 123456,
  runAttempt: 1,
  runUrl: `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/123456`,
  workflowRef: `${EXPECTED_REPOSITORY}/.github/workflows/chrome-web-store.yml@refs/heads/main`,
  workflowSha: '4'.repeat(40),
};
const UPLOAD_PROOF = {
  uploadResponseItemId: EXPECTED_EXTENSION_ID,
  uploadResponseName: name,
  uploadState: 'SUCCEEDED',
  crxVersion: '0.3.0',
};

function revision(state: string, version: string) {
  return { state, distributionChannels: [{ deployPercentage: 100, crxVersion: version }] };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    name,
    itemId: EXPECTED_EXTENSION_ID,
    publicKey: 'dGVzdA==',
    publishedItemRevisionStatus: revision('PUBLISHED', '0.2.1'),
    takenDown: false,
    warned: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, statusCode = 200) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

function attemptIssue(number: number, marker = formatAttemptMarker(ATTEMPT), state = 'open') {
  return {
    number,
    title: marker.title,
    body: marker.body,
    state,
    html_url: `https://github.com/${EXPECTED_REPOSITORY}/issues/${number}`,
  };
}

function rolloutIssue(number: number, marker: ReturnType<typeof formatRolloutLedgerMarker>, state = 'open') {
  return {
    number,
    title: marker.title,
    body: marker.body,
    state,
    html_url: `https://github.com/${EXPECTED_REPOSITORY}/issues/${number}`,
    user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
  };
}

function expectOnlyGitHubRequests(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  for (const [url] of fetchMock.mock.calls) expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//);
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{
  name: string;
  contents?: string | Buffer;
  versionMadeBy?: number;
  externalAttributes?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  comment?: string | Buffer;
}>, archiveComment: string | Buffer = Buffer.alloc(0)) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents ?? entry.name);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const comment = Buffer.from(entry.comment ?? '');
    const flags = name.some((byte) => byte > 0x7f) ? 0x0800 : 0;
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, name, localExtra, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name, centralExtra, comment);
    localOffset += local.length + name.length + localExtra.length + contents.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocdComment = Buffer.from(archiveComment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(eocdComment.length, 20);
  return Buffer.concat([...locals, centralBytes, eocd, eocdComment]);
}

function unicodePathExtra(originalName: string, alternateName: string) {
  const original = Buffer.from(originalName);
  const alternate = Buffer.from(alternateName);
  const extra = Buffer.alloc(9 + alternate.length);
  extra.writeUInt16LE(0x7075, 0);
  extra.writeUInt16LE(5 + alternate.length, 2);
  extra.writeUInt8(1, 4);
  extra.writeUInt32LE(crc32(original), 5);
  alternate.copy(extra, 9);
  return extra;
}

describe('release and Chrome version validation', () => {
  it('pins the exact safe publish request independently from the implementation', () => {
    expect(PUBLISH_REQUEST).toEqual(EXPECTED_PUBLISH_REQUEST);
  });
  it('accepts strict release tags and exact manual confirmation', () => {
    expect(parseReleaseTag('v0.3.0')).toBe('0.3.0');
    expect(() => requirePublishConfirmation('v0.3.0', 'publish v0.3.0')).not.toThrow();
    expect(() => requireManualPublishTag('v0.3.0')).not.toThrow();
    expect(() => requireManualPublishTag('v0.4.0')).toThrow(/restricted to legacy/);
    expect(() => requirePublishConfirmation('v0.3.0', 'publish 0.3.0')).toThrow(/exactly/);
    expect(() => requireUploadConfirmation('v0.3.0', 'upload draft v0.3.0 only')).not.toThrow();
    expect(() => requireSubmitConfirmation('v0.3.0',
      'submit v0.3.0 after saving alarms justification')).not.toThrow();
    for (const confirmation of [
      'Upload draft v0.3.0 only',
      'upload draft 0.3.0 only',
      'upload draft v0.3.0 only ',
      'upload draft v0.3.0',
    ]) expect(() => requireUploadConfirmation('v0.3.0', confirmation)).toThrow(/exactly/);
    for (const confirmation of [
      'Submit v0.3.0 after saving alarms justification',
      'submit 0.3.0 after saving alarms justification',
      'submit v0.3.0 after saving alarm justification',
      'submit v0.3.0 after saving alarms justification ',
    ]) expect(() => requireSubmitConfirmation('v0.3.0', confirmation)).toThrow(/exactly/);
    expect(() => parseReleaseTag('v01.3.0')).toThrow(/strict/);
    expect(() => parseReleaseTag('v0.3.0/asset')).toThrow(/strict/);
  });

  it('excludes legacy v0.3.0 release events while accepting future numeric event IDs', () => {
    expect(() => validateReleaseEvent('v0.3.0', '375937330')).toThrow(/excluded/);
    expect(validateReleaseEvent('v0.4.0', '400000000')).toBe(400000000);
    expect(() => validateReleaseEvent('v0.4.0', '1e3')).toThrow(/positive integer/);
  });

  it('implements Chrome one-to-four component integer ordering', () => {
    expect(parseChromeVersion('1.2.3.65535')).toEqual([1, 2, 3, 65535]);
    expect(compareChromeVersions('1.2.1', '1.2')).toBe(1);
    expect(compareChromeVersions('1.2.0', '1.2')).toBe(0);
    expect(compareChromeVersions('1.1.99', '1.2')).toBe(-1);
    expect(() => parseChromeVersion('1.2.3.65536')).toThrow(/65535/);
    expect(() => parseChromeVersion('1.02.3')).toThrow(/Invalid/);
    expect(() => parseChromeVersion('1.2.3.4.5')).toThrow(/Invalid/);
  });
});

describe('publishing workflow guards', () => {
  it('orders each protected ledger before its isolated mutation with least privilege', async () => {
    const workflow = await readFile(new URL('../.github/workflows/chrome-web-store.yml', import.meta.url), 'utf8');
    const document = loadYaml(workflow) as any;
    const uploadPlan = workflow.indexOf('- name: Plan v0.3.0 upload from current store status without mutation');
    const uploadAttempt = workflow.indexOf('- name: Create and verify canonical pre-upload attempt ledger');
    const upload = workflow.indexOf('- name: Upload v0.3.0 draft without publishing');
    const uploadSuccess = workflow.indexOf('- name: Create and verify canonical synchronous upload-success ledger');
    expect(uploadPlan).toBeGreaterThan(0);
    expect(uploadPlan).toBeLessThan(uploadAttempt);
    expect(uploadAttempt).toBeLessThan(upload);
    expect(upload).toBeLessThan(uploadSuccess);
    const verify = workflow.indexOf('- name: Verify exact linked upload ledgers before checking submit state');
    const submitPlan = workflow.indexOf('- name: Plan review submission from current store status without mutation');
    const submitAttempt = workflow.indexOf('- name: Create and verify canonical pre-submit attempt ledger');
    const submit = workflow.indexOf('- name: Submit verified v0.3.0 draft for review without uploading');
    expect(verify).toBeLessThan(submitPlan);
    expect(submitPlan).toBeLessThan(submitAttempt);
    expect(submitAttempt).toBeLessThan(submit);
    const futurePlan = workflow.indexOf('- name: Plan from current store status without mutation');
    const futureLedger = workflow.indexOf('- name: Create and verify public pre-mutation attempt ledger');
    const futureMutation = workflow.indexOf('- name: Upload and submit for automatic publication after review');
    expect(futurePlan).toBeLessThan(futureLedger);
    expect(futureLedger).toBeLessThan(futureMutation);
    expect(workflow).not.toContain('actions/cache');
    expect(workflow).not.toMatch(/deployInfos|cancelSubmission|cancelPublish|web_accessible_resources/);
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(document.jobs.validate.permissions).toBeUndefined();
    expect(document.jobs.status.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(document.jobs.upload.permissions).toEqual({ contents: 'read', 'id-token': 'write', issues: 'write' });
    expect(document.jobs.submit.permissions).toEqual({ contents: 'read', 'id-token': 'write', issues: 'write' });
    expect(document.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write', issues: 'write' });
    expect(document.jobs.upload.environment).toBe('chrome-web-store');
    expect(document.jobs.submit.environment).toBe('chrome-web-store');
    expect(document.jobs.publish.environment).toBe('chrome-web-store');
    expect(document.concurrency['cancel-in-progress']).toBe(false);
    const uploadSteps = document.jobs.upload.steps;
    const uploadMutation = uploadSteps.find((step: any) => step.name === 'Upload v0.3.0 draft without publishing');
    const uploadSuccessStep = uploadSteps.find((step: any) =>
      step.name === 'Create and verify canonical synchronous upload-success ledger');
    expect(uploadMutation.run).toContain('upload-draft');
    expect(uploadMutation.run).not.toMatch(/chrome-web-store\.mjs publish(?:\s|$)|submit-review|:publish/);
    expect(uploadSuccessStep.if).toBe("steps.upload-draft.outputs.mutated == 'true'");
    expect(uploadSuccessStep.run).toContain('--upload-state "${UPLOAD_STATE}"');
    const submitMutation = document.jobs.submit.steps.find((step: any) =>
      step.name === 'Submit verified v0.3.0 draft for review without uploading');
    expect(submitMutation.run).toContain('submit-review');
    expect(submitMutation.run).not.toMatch(/--artifact|upload-draft|\/upload\/v2/);
  });

  it('exposes only split manual mutations on main and preserves future release automation', async () => {
    const workflow = await readFile(new URL('../.github/workflows/chrome-web-store.yml', import.meta.url), 'utf8');
    const document = loadYaml(workflow) as any;
    expect(document.on.workflow_dispatch.inputs.operation.options).toEqual(['validate', 'status', 'upload', 'submit']);
    expect(document.jobs.validate.if).toBeUndefined();
    expect(document.jobs.status.if).toContain("github.ref == 'refs/heads/main'");
    expect(document.jobs.upload.if).toContain("github.ref == 'refs/heads/main'");
    expect(document.jobs.submit.if).toContain("github.ref == 'refs/heads/main'");
    expect(document.jobs.upload.if).toContain("inputs.release_tag == 'v0.3.0'");
    expect(document.jobs.submit.if).toContain("inputs.release_tag == 'v0.3.0'");
    expect(document.jobs.upload.if).toContain("inputs.operation == 'upload'");
    expect(document.jobs.submit.if).toContain("inputs.operation == 'submit'");
    for (const job of ['upload', 'submit', 'publish']) {
      expect(document.jobs[job].needs).toBe('validate');
    }
    const validateRelease = document.jobs.validate.steps.find((step: any) =>
      step.name === 'Validate exact GitHub release and package');
    expect(validateRelease.env.OPERATION).toBe("${{ github.event_name == 'release' && 'publish' || inputs.operation }}");
    expect(validateRelease.env.CONFIRMATION).toBe('${{ inputs.confirmation }}');
    expect(validateRelease.run).toContain('--operation "${OPERATION}"');
    expect(validateRelease.run).toContain('args+=(--confirmation "${CONFIRMATION}")');
    const uploadRerunGuard = document.jobs.upload.steps.find((step: any) =>
      step.name === 'Refuse an in-place upload rerun before mutation');
    const submitRerunGuard = document.jobs.submit.steps.find((step: any) =>
      step.name === 'Refuse an in-place submit rerun before mutation');
    expect(uploadRerunGuard.if).toBe("steps.plan.outputs.action == 'upload' && github.run_attempt != 1");
    expect(submitRerunGuard.if).toBe("steps.plan.outputs.action == 'submit' && github.run_attempt != 1");
    const submitPlan = document.jobs.submit.steps.find((step: any) =>
      step.name === 'Plan review submission from current store status without mutation');
    expect(submitPlan.env.SUBMIT_ATTEMPT_EXISTS).toBe('${{ steps.upload-ledgers.outputs.submit_attempt_exists }}');
    expect(submitPlan.run).toContain('--submit-attempt-exists "${SUBMIT_ATTEMPT_EXISTS:-false}"');
    expect(document.jobs.publish.if).toContain("github.event.release.tag_name != 'v0.3.0'");
    expect(document.jobs.publish.if).not.toContain('workflow_dispatch');
    expect(workflow.slice(workflow.indexOf('  upload:'), workflow.indexOf('  submit:'))).not.toContain(':publish');
    expect(workflow.slice(workflow.indexOf('  submit:'), workflow.indexOf('  publish:'))).not.toContain('/upload/v2');
    expect(workflow.slice(workflow.indexOf('  submit:'), workflow.indexOf('  publish:'))).not.toContain('--artifact "${ARTIFACT_PATH}"\n          --version');
  });
});

describe('durable publish attempt ledger', () => {
  it('formats and validates a canonical injection-safe marker', () => {
    const marker = formatAttemptMarker(ATTEMPT);
    expect(validateAttemptMarker(marker.title, marker.body)).toEqual(marker.payload);
    expect(marker.body).toContain('pre-mutation publish attempt');
    expect(marker.body).toContain('administrator edit or deletion is the only bypass');
    expect(() => formatAttemptMarker({ ...ATTEMPT, tag: 'v0.3.0\nissue' })).toThrow(/strict/);
    expect(() => validateAttemptMarker(marker.title, `${marker.body}changed`)).toThrow(/not recognized/);
  });

  it('lists all issues, ignores pull requests, then creates and fetches the exact issue', async () => {
    const marker = formatAttemptMarker(ATTEMPT);
    const pullRequest = { ...attemptIssue(8, marker), pull_request: { url: 'https://api.github.com/pulls/8' } };
    const created = attemptIssue(9, marker);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([pullRequest]))
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(created));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: fetchMock }))
      .resolves.toMatchObject({ issueNumber: 9, issueUrl: created.html_url });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toContain('/issues?state=all&sort=created&direction=asc&per_page=100&page=1');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ title: marker.title, body: marker.body }),
    });
    expect(fetchMock.mock.calls[2]![0]).toMatch('/issues/9');
    expectOnlyGitHubRequests(fetchMock);
  });

  it.each(['open', 'closed'])('blocks a prior %s marker without creating an issue', async (state) => {
    const priorRunMarker = formatAttemptMarker({
      ...ATTEMPT, runUrl: `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/999`,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([attemptIssue(4, priorRunMarker, state)]));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: fetchMock }))
      .rejects.toThrow(/already exists/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectOnlyGitHubRequests(fetchMock);
  });

  it('paginates repository-wide issue history and finds an older marker', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `Other issue ${index}` }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([attemptIssue(101, undefined, 'closed')]));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: fetchMock }))
      .rejects.toThrow(/already exists/);
    expect(fetchMock.mock.calls[1]![0]).toContain('page=2');
    expectOnlyGitHubRequests(fetchMock);
  });

  it('stops on issue-list and issue-verification errors', async () => {
    const listFailure = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: listFailure }))
      .rejects.toThrow(/issue list failed with HTTP 403/);
    expectOnlyGitHubRequests(listFailure);

    const created = attemptIssue(12);
    const verifyFailure = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: verifyFailure }))
      .rejects.toThrow(/verification failed with HTTP 503/);
    expectOnlyGitHubRequests(verifyFailure);
  });

  it('stops on create errors, timeouts, and malformed success responses', async () => {
    const createError = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ message: 'denied' }, 403));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: createError }))
      .rejects.toThrow(/creation failed with HTTP 403/);
    expectOnlyGitHubRequests(createError);

    const createTimeout = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(() => new Promise(() => {}));
    await expect(claimPublishAttempt({
      ...ATTEMPT, token: 'github-token', fetchImpl: createTimeout, requestTimeoutMs: 5,
    })).rejects.toThrow(/creation timed out/);
    expectOnlyGitHubRequests(createTimeout);

    const malformedCreate = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ number: 13, state: 'open' }, 201));
    await expect(claimPublishAttempt({ ...ATTEMPT, token: 'github-token', fetchImpl: malformedCreate }))
      .rejects.toThrow(/marker does not match/);
    expect(malformedCreate).toHaveBeenCalledTimes(2);
    expectOnlyGitHubRequests(malformedCreate);
  });
});

describe('two-stage rollout ledgers', () => {
  it('formats canonical upload-attempt, upload-success, and submit-attempt identities and links', () => {
    const attempt = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const success = formatRolloutLedgerMarker('uploadSuccess', {
      ...ROLLOUT,
      ...UPLOAD_PROOF,
      uploadAttemptIssueNumber: 10,
      uploadAttemptIssueUrl: `https://github.com/${EXPECTED_REPOSITORY}/issues/10`,
    });
    const submit = formatRolloutLedgerMarker('submitAttempt', {
      ...ROLLOUT,
      runId: 789,
      runUrl: `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/789`,
      uploadAttemptIssueNumber: 10,
      uploadAttemptIssueUrl: `https://github.com/${EXPECTED_REPOSITORY}/issues/10`,
      uploadSuccessIssueNumber: 11,
      uploadSuccessIssueUrl: `https://github.com/${EXPECTED_REPOSITORY}/issues/11`,
    });
    for (const marker of [attempt, success, submit]) {
      expect(validateRolloutLedgerMarker(marker.title, marker.body)).toEqual(marker);
      expect(marker.payload).toMatchObject({
        repository: EXPECTED_REPOSITORY,
        repositoryId: EXPECTED_REPOSITORY_ID,
        releaseTag: 'v0.3.0',
        releaseVersion: '0.3.0',
        releaseId: 375937330,
        assetId: 528076253,
        assetName: 'eipeek-0.3.0-chrome.zip',
        assetSize: 151532,
        sha256: '2'.repeat(64),
        publisherId: PUBLISHER_ID,
        extensionId: EXPECTED_EXTENSION_ID,
        runAttempt: 1,
        workflowRef: ROLLOUT.workflowRef,
        workflowSha: ROLLOUT.workflowSha,
      });
      expect(marker.payload.releaseUrl).toMatch(/^https:\/\/github\.com\//);
      expect(marker.payload.assetUrl).toMatch(/^https:\/\/github\.com\//);
      expect(marker.payload.commitUrl).toMatch(/^https:\/\/github\.com\//);
      expect(marker.payload.cwsStatusUrl).toMatch(/:fetchStatus$/);
      expect(marker.payload.workflowUrl).toContain(ROLLOUT.workflowSha);
    }
    expect(success.payload).toMatchObject(UPLOAD_PROOF);
    expect(() => formatRolloutLedgerMarker('uploadSuccess', {
      ...ROLLOUT,
      ...UPLOAD_PROOF,
      uploadState: 'IN_PROGRESS',
      uploadAttemptIssueNumber: 10,
      uploadAttemptIssueUrl: `https://github.com/${EXPECTED_REPOSITORY}/issues/10`,
    })).toThrow(/must record SUCCEEDED/);
  });

  it('creates and re-fetches an exact upload attempt and forbids every later retry', async () => {
    const marker = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const created = rolloutIssue(10, marker);
    const createFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(created))
      .mockResolvedValueOnce(jsonResponse([created]));
    await expect(claimUploadAttempt({ ...ROLLOUT, token: 'github-token', fetchImpl: createFetch }))
      .resolves.toMatchObject({ issueNumber: 10, issueUrl: created.html_url });
    expect(createFetch).toHaveBeenCalledTimes(4);
    expectOnlyGitHubRequests(createFetch);

    for (const state of ['open', 'closed']) {
      const retryFetch = vi.fn().mockResolvedValueOnce(jsonResponse([rolloutIssue(10, marker, state)]));
      await expect(claimUploadAttempt({ ...ROLLOUT, token: 'github-token', fetchImpl: retryFetch }))
        .rejects.toThrow(/automated upload retry is forbidden/);
      expect(retryFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed on malformed, duplicate, and mismatched staged records', async () => {
    const attempt = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const malformed = { ...rolloutIssue(1, attempt), body: `${attempt.body}changed` };
    const mismatchMarker = formatRolloutLedgerMarker('uploadAttempt', { ...ROLLOUT, assetSize: 151533 });
    for (const [issues, message] of [
      [[malformed], /malformed or mismatched/i],
      [[rolloutIssue(1, attempt), rolloutIssue(2, attempt)], /duplicate/i],
      [[rolloutIssue(1, mismatchMarker)], /does not match/i],
      [[{ ...rolloutIssue(1, attempt), title: 'Other title' }], /canonical title/i],
      [[{ ...rolloutIssue(1, attempt), user: { login: 'attacker', id: 1, type: 'User' } }], /authenticated GitHub Actions bot/i],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(issues));
      await expect(verifyUploadLedgers({ ...ROLLOUT, token: 'github-token', fetchImpl: fetchMock }))
        .rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectOnlyGitHubRequests(fetchMock);
    }
  });

  it('re-scans after creation and catches a raced duplicate before returning authorization', async () => {
    const marker = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const created = rolloutIssue(10, marker);
    const raced = rolloutIssue(11, marker);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(created))
      .mockResolvedValueOnce(jsonResponse([created, raced]));
    await expect(claimUploadAttempt({ ...ROLLOUT, token: 'github-token', fetchImpl: fetchMock }))
      .rejects.toThrow(/duplicate/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('records success only after one attempt, verifies the exact link, then claims one submit attempt', async () => {
    const attemptMarker = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const attempt = rolloutIssue(10, attemptMarker);
    const successMarker = formatRolloutLedgerMarker('uploadSuccess', {
      ...ROLLOUT,
      ...UPLOAD_PROOF,
      uploadAttemptIssueNumber: 10,
      uploadAttemptIssueUrl: attempt.html_url,
    });
    const success = rolloutIssue(11, successMarker);
    const successFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([attempt]))
      .mockResolvedValueOnce(jsonResponse(success, 201))
      .mockResolvedValueOnce(jsonResponse(success))
      .mockResolvedValueOnce(jsonResponse([attempt, success]));
    await expect(recordUploadSuccess({
      ...ROLLOUT, ...UPLOAD_PROOF, token: 'github-token', fetchImpl: successFetch,
    }))
      .resolves.toMatchObject({ issueNumber: 11, uploadAttemptIssueNumber: 10 });
    expectOnlyGitHubRequests(successFetch);

    const verifyFetch = vi.fn().mockResolvedValueOnce(jsonResponse([attempt, success]));
    await expect(verifyUploadLedgers({ ...ROLLOUT, token: 'github-token', fetchImpl: verifyFetch }))
      .resolves.toMatchObject({
        uploadAttemptIssueNumber: 10,
        uploadSuccessIssueNumber: 11,
        submitAttemptExists: false,
      });

    const submitMarker = formatRolloutLedgerMarker('submitAttempt', {
      ...ROLLOUT,
      uploadAttemptIssueNumber: 10,
      uploadAttemptIssueUrl: attempt.html_url,
      uploadSuccessIssueNumber: 11,
      uploadSuccessIssueUrl: success.html_url,
    });
    const submit = rolloutIssue(12, submitMarker);
    const submitFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([attempt, success]))
      .mockResolvedValueOnce(jsonResponse(submit, 201))
      .mockResolvedValueOnce(jsonResponse(submit))
      .mockResolvedValueOnce(jsonResponse([attempt, success, submit]));
    await expect(claimSubmitAttempt({ ...ROLLOUT, token: 'github-token', fetchImpl: submitFetch }))
      .resolves.toMatchObject({ issueNumber: 12 });
    expectOnlyGitHubRequests(submitFetch);
  });

  it('requires exactly one linked success and rejects altered or duplicate linkage', async () => {
    const attemptMarker = formatRolloutLedgerMarker('uploadAttempt', ROLLOUT);
    const attempt = rolloutIssue(10, attemptMarker);
    const missingFetch = vi.fn().mockResolvedValueOnce(jsonResponse([attempt]));
    await expect(verifyUploadLedgers({ ...ROLLOUT, token: 'github-token', fetchImpl: missingFetch }))
      .rejects.toThrow(/exactly one canonical linked upload success/i);

    const successMarker = formatRolloutLedgerMarker('uploadSuccess', {
      ...ROLLOUT,
      ...UPLOAD_PROOF,
      uploadAttemptIssueNumber: 9,
      uploadAttemptIssueUrl: `https://github.com/${EXPECTED_REPOSITORY}/issues/9`,
    });
    const badLinkFetch = vi.fn().mockResolvedValueOnce(jsonResponse([attempt, rolloutIssue(11, successMarker)]));
    await expect(verifyUploadLedgers({ ...ROLLOUT, token: 'github-token', fetchImpl: badLinkFetch }))
      .rejects.toThrow(/does not link the exact upload attempt/i);
  });
});

describe('release artifact invariants', () => {
  it('pins every mutable v0.3.0 release identity fact', () => {
    const result = validateReleaseRecord({
      repository: EXPECTED_REPOSITORY,
      repositoryRecord: {
        id: EXPECTED_REPOSITORY_ID,
        full_name: EXPECTED_REPOSITORY,
        owner: { id: EXPECTED_OWNER_ID },
      },
      release: {
        id: 375937330,
        tag_name: 'v0.3.0',
        draft: false,
        prerelease: false,
        published_at: '2026-08-24T00:00:00Z',
        assets: [{
          id: 528076253,
          name: 'eipeek-0.3.0-chrome.zip',
          size: 151532,
          state: 'uploaded',
          digest: 'sha256:969ca245db8ea0410b11113b69fb5597f08c44ad04fefe151d84b9414a65de93',
        }],
      },
      tag: 'v0.3.0',
      tagObject: 'baafbb0244419ff317d8a05cd1f824d33a87fa64',
      commit: '09815745f301ddf9e3c913f94959b2c873b2d876',
    });
    expect(result).toMatchObject({ releaseId: 375937330, assetId: 528076253, assetSize: 151532 });
  });

  it('requires immutable future releases with GitHub-provided digests', () => {
    const futureRelease = {
      id: 400000000,
      tag_name: 'v0.4.0',
      draft: false,
      prerelease: false,
      published_at: '2026-09-01T00:00:00Z',
      assets: [{
        id: 600000000,
        name: 'eipeek-0.4.0-chrome.zip',
        size: 100,
        state: 'uploaded',
        digest: `sha256:${'3'.repeat(64)}`,
      }],
    };
    const input = {
      repository: EXPECTED_REPOSITORY,
      repositoryRecord: {
        id: EXPECTED_REPOSITORY_ID,
        full_name: EXPECTED_REPOSITORY,
        owner: { id: EXPECTED_OWNER_ID },
      },
      release: futureRelease,
      tag: 'v0.4.0',
      tagObject: '1'.repeat(40),
      commit: '2'.repeat(40),
    };
    expect(() => validateReleaseRecord(input)).toThrow(/immutable/);
    expect(validateReleaseRecord({
      ...input,
      release: { ...futureRelease, immutable: true },
    })).toMatchObject({ immutable: true, apiSha256: '3'.repeat(64) });
    expect(() => validateReleaseRecord({
      ...input,
      release: {
        ...futureRelease,
        immutable: true,
        assets: [{ ...futureRelease.assets[0], digest: undefined }],
      },
    })).toThrow(/SHA-256 digest/);
  });

  it('validates manifest identity and least-privilege permissions', () => {
    const manifest = { manifest_version: 3, name: 'EIPeek', version: '0.3.0', permissions: ['storage', 'alarms'] };
    expect(validateManifest(manifest, '0.3.0')).toBe(manifest);
    expect(() => validateManifest({ ...manifest, permissions: ['storage', 'tabs'] }, '0.3.0')).toThrow(/exactly/);
    expect(() => validateManifest({ ...manifest, host_permissions: ['<all_urls>'] }, '0.3.0')).toThrow(/host_permissions/);
    for (const field of ['optional_permissions', 'optional_host_permissions', 'externally_connectable',
      'web_accessible_resources']) {
      expect(() => validateManifest({ ...manifest, [field]: [] }, '0.3.0')).toThrow(field);
    }
    expect(() => validateManifest({ ...manifest, version: '0.2.1' }, '0.3.0')).toThrow(/version/);
  });

  it('parses only unique, safe, regular ZIP file entries', () => {
    expect([...parseZipFiles(storedZip([{ name: 'manifest.json', contents: '{}' }])).keys()])
      .toEqual(['manifest.json']);
    expect(() => parseZipFiles(storedZip([{ name: '../manifest.json' }]))).toThrow(/Unsafe/);
    expect(() => parseZipFiles(storedZip([
      { name: '\u00e9.txt' },
      { name: 'e\u0301.txt' },
    ]))).toThrow(/duplicate normalized/);
    expect(() => parseZipFiles(storedZip([{
      name: 'link',
      versionMadeBy: (3 << 8) | 20,
      externalAttributes: (0o120777 << 16) >>> 0,
    }]))).toThrow(/not a regular file/);
  });

  it('rejects Info-ZIP Unicode path extra fields that can supply alternate names', () => {
    const alternate = unicodePathExtra('manifest.json', '../manifest.json');
    expect(() => parseZipFiles(storedZip([{
      name: 'manifest.json', contents: '{}', centralExtra: alternate,
    }]))).toThrow(/central extra fields/);
    expect(() => parseZipFiles(storedZip([{
      name: 'manifest.json', contents: '{}', localExtra: alternate,
    }]))).toThrow(/local extra fields/);
  });

  it('rejects entry and archive comments', () => {
    expect(() => parseZipFiles(storedZip([{
      name: 'manifest.json', contents: '{}', comment: 'alternate metadata',
    }]))).toThrow(/entry comments/);
    expect(() => parseZipFiles(storedZip([
      { name: 'manifest.json', contents: '{}' },
    ], 'archive metadata'))).toThrow(/archive comments/);
  });

  it('compares normalized ZIP paths and every file byte with a built directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eipeek-cws-'));
    const build = join(root, 'build');
    const archive = join(root, 'release.zip');
    try {
      await mkdir(join(build, 'nested'), { recursive: true });
      await writeFile(join(build, 'manifest.json'), '{"version":"0.3.0"}');
      await writeFile(join(build, 'nested', 'script.js'), 'trusted bytes');
      await writeFile(archive, storedZip([
        { name: 'nested/script.js', contents: 'trusted bytes' },
        { name: 'manifest.json', contents: '{"version":"0.3.0"}' },
      ]));
      await expect(compareZipToDirectory(archive, build)).resolves.toEqual({ fileCount: 2 });

      await writeFile(archive, storedZip([{ name: 'wrapper/manifest.json', contents: '{"version":"0.3.0"}' }]));
      await expect(compareZipToDirectory(archive, build)).rejects.toThrow(/tree differs/);
      await writeFile(archive, storedZip([
        { name: 'nested/script.js', contents: 'different bytes' },
        { name: 'manifest.json', contents: '{"version":"0.3.0"}' },
      ]));
      await expect(compareZipToDirectory(archive, build)).rejects.toThrow(/file bytes differ/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Chrome Web Store identity', () => {
  it('accepts only safe version 4 UUID publisher path components', () => {
    expect(() => validatePublisherId(PUBLISHER_ID)).not.toThrow();
    expect(() => validatePublisherId('')).toThrow(/publisher ID/);
    expect(() => validatePublisherId('00000000-0000-5000-8000-000000000000')).toThrow(/publisher ID/);
    expect(() => validatePublisherId('00000000-0000-4000-8000-000000000000/items')).toThrow(/publisher ID/);
  });

  it('derives an extension ID from decoded public-key bytes', () => {
    const keyBytes = Buffer.from('deterministic public key fixture');
    const hex = createHash('sha256').update(keyBytes).digest('hex').slice(0, 32);
    const expected = [...hex].map((character) =>
      String.fromCharCode(97 + Number.parseInt(character, 16))).join('');
    expect(deriveExtensionId(keyBytes.toString('base64'))).toBe(expected);
    expect(deriveExtensionId(`-----BEGIN PUBLIC KEY-----\n${keyBytes.toString('base64')}\n-----END PUBLIC KEY-----`)).toBe(expected);
  });

  it('rejects item ID and resource-name mismatches in every response type', () => {
    expect(() => verifyItemIdentity({ name, itemId: 'a'.repeat(32) }, PUBLISHER_ID,
      EXPECTED_EXTENSION_ID, 'upload')).toThrow(/item ID/);
    expect(() => verifyItemIdentity({ name: `${name}x`, itemId: EXPECTED_EXTENSION_ID },
      PUBLISHER_ID, EXPECTED_EXTENSION_ID, 'publish')).toThrow(/item name/);
  });
});

describe('fail-closed publish decisions', () => {
  it('rejects warnings, takedowns, downgrades, and conflicting submissions', () => {
    expect(() => decidePublishAction(status({ warned: true }), '0.3.0')).toThrow(/warning/);
    expect(() => decidePublishAction(status({ takenDown: true }), '0.3.0')).toThrow(/taken down/);
    expect(() => decidePublishAction(status(), '0.2.0')).toThrow(/downgrade/);
    expect(() => decidePublishAction(status({
      submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.2.9'),
    }), '0.3.0')).toThrow(/conflicting/);
    expect(() => decidePublishAction(status({
      submittedItemRevisionStatus: revision('STAGED', '0.3.0'),
    }), '0.3.0')).toThrow(/manual resolution/);
    expect(() => decidePublishAction(status({
      submittedItemRevisionStatus: revision('REJECTED', '0.3.0'),
    }), '0.3.0')).toThrow(/newer release/);
    expect(() => decidePublishAction(status({ lastAsyncUploadState: 'IN_PROGRESS' }), '0.3.0')).toThrow(/in progress/);
    expect(() => decidePublishAction(status({ lastAsyncUploadState: 'FAILED' }), '0.3.0')).toThrow(/ambiguous draft/);
  });

  it('returns audited no-ops for the exact pending or published version', () => {
    expect(decidePublishAction(status({
      submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.0'),
    }), '0.3.0')).toMatchObject({ action: 'noop', reason: 'pending_review' });
    expect(decidePublishAction(status({
      publishedItemRevisionStatus: revision('PUBLISHED', '0.3.0'),
    }), '0.3.0')).toMatchObject({ action: 'noop', reason: 'already-published' });
  });

  it('allows only a strictly newer, unconflicted package to upload', () => {
    expect(decidePublishAction(status(), '0.3.0')).toEqual({
      action: 'upload', reason: 'new-version', version: '0.3.0',
    });
    expect(() => decidePublishAction(status({ lastAsyncUploadState: 'SUCCEEDED' }), '0.3.0')).toThrow(/ambiguous/);
  });
});

describe('fail-closed staged submission decisions', () => {
  const verified = { uploadLedgersVerified: true };

  it('allows a lower published version with no submitted revision only after exact upload ledgers', () => {
    expect(decideSubmitAction(status(), '0.3.0', verified)).toEqual({
      action: 'submit', reason: 'verified-synchronous-upload', version: '0.3.0',
    });
    expect(decideSubmitAction(status({ lastAsyncUploadState: 'SUCCEEDED' }), '0.3.0', verified))
      .toMatchObject({ action: 'submit' });
    expect(decideSubmitAction(status({ lastAsyncUploadState: undefined }), '0.3.0', verified))
      .toMatchObject({ action: 'submit' });
    expect(() => decideSubmitAction(status(), '0.3.0')).toThrow(/ledgers/i);
  });

  it('uses exact pending/published read-only no-ops, including after an attempt issue exists', () => {
    expect(decideSubmitAction(status({
      submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.0'),
    }), '0.3.0', { ...verified, submitAttemptExists: true })).toMatchObject({ action: 'noop' });
    expect(decideSubmitAction(status({
      publishedItemRevisionStatus: revision('PUBLISHED', '0.3.0'),
    }), '0.3.0', { ...verified, submitAttemptExists: true })).toMatchObject({ action: 'noop' });
    expect(() => decideSubmitAction(status(), '0.3.0', {
      ...verified, submitAttemptExists: true,
    })).toThrow(/attempt ledger exists without an exact pending or published/i);
  });

  it('rejects every dangerous or conflicting state', () => {
    for (const candidate of [
      status({ warned: true }),
      status({ takenDown: true }),
      status({ lastAsyncUploadState: 'IN_PROGRESS' }),
      status({ lastAsyncUploadState: 'FAILED' }),
      status({ submittedItemRevisionStatus: revision('STAGED', '0.3.0') }),
      status({ submittedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', '0.3.0') }),
      status({ submittedItemRevisionStatus: revision('REJECTED', '0.3.0') }),
      status({ submittedItemRevisionStatus: revision('CANCELLED', '0.3.0') }),
      status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.4.0') }),
      status({ publishedItemRevisionStatus: revision('PUBLISHED', '0.4.0') }),
    ]) expect(() => decideSubmitAction(candidate, '0.3.0', verified)).toThrow();
  });
});

describe('direct API operations', () => {
  it('keeps status read-only and uses fetchStatus only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status()));
    await expect(fetchStoreStatus({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).resolves.toMatchObject({ itemId: EXPECTED_EXTENSION_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[0]![0]).toMatch(/:fetchStatus$/);
  });

  it('does not mutate when the exact requested version is pending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status({
      submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.0'),
    })));
    const result = await publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    });
    expect(result.mutated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a read-only publish plan before marker or mutation handling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status()));
    await expect(planStorePublish({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).resolves.toMatchObject({ decision: { action: 'upload', version: '0.3.0' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('plans upload and submit through read-only fetchStatus only', async () => {
    for (const [planner, options, action] of [
      [planStoreUpload, {}, 'upload'],
      [planStoreSubmit, { uploadLedgersVerified: true, submitAttemptExists: false }, 'submit'],
    ] as const) {
      const fetchMock = vi.fn(async (url: string) => {
        if (url !== statusUrl) throw new Error(`Unexpected URL ${url}`);
        return jsonResponse(status());
      });
      await expect(planner({
        publisherId: PUBLISHER_ID,
        extensionId: EXPECTED_EXTENSION_ID,
        accessToken: 'test-token',
        version: '0.3.0',
        fetchImpl: fetchMock,
        deriveId: deriveExpectedId,
        ...options,
      })).resolves.toMatchObject({ decision: { action } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('uploads a draft from a direct synchronous proof and never calls publish', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      seen.push(url);
      if (url === statusUrl) return jsonResponse(status());
      if (url === uploadUrl) {
        expect(options).toMatchObject({ method: 'POST', body: Buffer.from('zip') });
        return jsonResponse({
          name, itemId: EXPECTED_EXTENSION_ID, crxVersion: '0.3.0', uploadState: 'SUCCEEDED',
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(uploadDraftToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).resolves.toMatchObject({ mutated: true, decision: { action: 'uploaded' } });
    expect(seen).toEqual([statusUrl, uploadUrl]);
    expect(seen).not.toContain(publishUrl);
  });

  it.each([
    ['async', { name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'IN_PROGRESS' }],
    ['missing version', { name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'SUCCEEDED' }],
    ['wrong version', { name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'SUCCEEDED', crxVersion: '0.3.1' }],
    ['wrong identity', { name, itemId: 'a'.repeat(32), uploadState: 'SUCCEEDED', crxVersion: '0.3.0' }],
  ])('treats a %s upload response as uncertain and cannot authorize submit', async (_label, response) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === statusUrl) return jsonResponse(status());
      if (url === uploadUrl) return jsonResponse(response);
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(uploadDraftToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown/i);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([statusUrl, uploadUrl]);
  });

  it('submits without accepting or sending an artifact and never calls upload', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      seen.push(url);
      if (url === statusUrl) return jsonResponse(status({ lastAsyncUploadState: 'SUCCEEDED' }));
      if (url === publishUrl) {
        expect(options).toMatchObject({
          method: 'POST',
          body: JSON.stringify(EXPECTED_PUBLISH_REQUEST),
        });
        return jsonResponse({ name, itemId: EXPECTED_EXTENSION_ID, state: 'PENDING_REVIEW' });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).resolves.toMatchObject({ mutated: true, decision: { action: 'submitted' } });
    expect(seen).toEqual([statusUrl, publishUrl]);
    expect(seen).not.toContain(uploadUrl);

    const noNetwork = vi.fn(() => { throw new Error('network must not run'); });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      artifact: '/tmp/release.zip',
      fetchImpl: noNetwork,
    })).rejects.toThrow(/does not accept an artifact/i);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('uses a read-only submit no-op for the exact pending version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== statusUrl) throw new Error(`Unexpected URL ${url}`);
      return jsonResponse(status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.0') }));
    });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).resolves.toMatchObject({ mutated: false, decision: { action: 'noop' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP error', () => jsonResponse({ error: { message: 'temporary' } }, 503)],
    ['non-JSON success', () => new Response('not-json', { status: 200 })],
    ['wrong identity', () => jsonResponse({ name, itemId: 'a'.repeat(32), state: 'PENDING_REVIEW' })],
    ['tester-only state', () => jsonResponse({ name, itemId: EXPECTED_EXTENSION_ID, state: 'PUBLISHED_TO_TESTERS' })],
    ['warnings', () => jsonResponse({
      name,
      itemId: EXPECTED_EXTENSION_ID,
      state: 'PENDING_REVIEW',
      warningInfo: { warnings: [{ reason: 'fixture' }] },
    })],
  ])('treats submit %s as an unknown outcome without any upload', async (_label, response) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === statusUrl) return jsonResponse(status());
      if (url === publishUrl) return response();
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown/i);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([statusUrl, publishUrl]);
  });

  it('treats submit aborts and timeouts as unknown and non-retryable', async () => {
    const aborted = vi.fn(async (url: string) => {
      if (url === statusUrl) return jsonResponse(status());
      if (url === publishUrl) throw new DOMException('request aborted', 'AbortError');
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      fetchImpl: aborted,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*aborted/i);

    const timedOut = vi.fn((url: string) => {
      if (url === statusUrl) return Promise.resolve(jsonResponse(status()));
      if (url === publishUrl) return new Promise<Response>(() => {});
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(submitDraftForReview({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      version: '0.3.0',
      uploadLedgersVerified: true,
      fetchImpl: timedOut,
      deriveId: deriveExpectedId,
      requestTimeoutMs: 5,
    })).rejects.toThrow(/outcome is unknown.*timed out/i);
  });

  it('retains the combined upload-and-submit helper for future releases', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, crxVersion: '0.4.0', uploadState: 'SUCCEEDED',
      }))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, state: 'PENDING_REVIEW',
      }));
    const result = await publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.4.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    });
    expect(result.mutated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toMatch('/upload/v2/');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: Buffer.from('zip') });
    expect(fetchMock.mock.calls[2]![0]).toMatch(/:publish$/);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string)).toEqual(EXPECTED_PUBLISH_REQUEST);
  });

  it('polls an asynchronous upload with read-only requests before publishing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'IN_PROGRESS',
      }))
      .mockResolvedValueOnce(jsonResponse(status({ lastAsyncUploadState: 'SUCCEEDED' })))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, state: 'PENDING_REVIEW',
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
      sleep,
    });
    expect(result.mutated).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[2]![0]).toMatch(/:fetchStatus$/);
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[3]![0]).toMatch(/:publish$/);
  });

  it('stops when an API response has the wrong item identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: 'a'.repeat(32), crxVersion: '0.3.0', uploadState: 'SUCCEEDED',
      }));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*item ID/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires crxVersion on a synchronous successful upload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'SUCCEEDED',
      }));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*version/i);
  });

  it.each([
    ['HTTP 5xx', () => jsonResponse({ error: { message: 'temporary' } }, 503)],
    ['malformed success', () => new Response('not-json', { status: 200 })],
    ['schema mismatch', () => jsonResponse({ name, itemId: EXPECTED_EXTENSION_ID, uploadState: 'UNKNOWN' })],
  ])('treats upload %s as an unknown mutation outcome', async (_label, uploadResponse) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(uploadResponse());
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown; do not retry or rerun the mutation blindly/i);
  });

  it('treats upload aborts and bounded timeouts as unknown mutation outcomes', async () => {
    const abortedFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockRejectedValueOnce(new DOMException('request aborted', 'AbortError'));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: abortedFetch,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*aborted/i);

    const timedOutFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockImplementationOnce(() => new Promise(() => {}));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: timedOutFetch,
      deriveId: deriveExpectedId,
      requestTimeoutMs: 5,
    })).rejects.toThrow(/outcome is unknown.*timed out/i);
  });

  it('keeps pre-mutation status failures explicitly read-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/failed during a read-only request/);
  });

  it('fails loudly if publish returns a warning despite blockOnWarnings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, crxVersion: '0.3.0', uploadState: 'SUCCEEDED',
      }))
      .mockResolvedValueOnce(jsonResponse({
        name,
        itemId: EXPECTED_EXTENSION_ID,
        state: 'PENDING_REVIEW',
        warningInfo: { warnings: [{ reason: 'TEST', description: 'fixture warning' }] },
      }));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*warnings/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats a testers-only publish response as an unknown mutation outcome', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, crxVersion: '0.3.0', uploadState: 'SUCCEEDED',
      }))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, state: 'PUBLISHED_TO_TESTERS',
      }));
    await expect(publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    })).rejects.toThrow(/outcome is unknown.*PUBLISHED_TO_TESTERS/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
