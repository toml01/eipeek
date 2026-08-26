#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';


export const EXPECTED_REPOSITORY = 'toml01/eipeek';
export const EXPECTED_REPOSITORY_ID = 1323913771;
export const EXPECTED_OWNER_ID = 7473870;
export const EXPECTED_EXTENSION_ID = 'jeehadjadegokhcgmnnkdcenbpbolkll';
export const PUBLISH_REQUEST = Object.freeze({
  publishType: 'DEFAULT_PUBLISH',
  skipReview: false,
  blockOnWarnings: true,
});

const LEGACY_RELEASES = Object.freeze({
  'v0.3.0': Object.freeze({
    releaseId: 375937330,
    assetId: 528076253,
    assetSize: 151532,
    sha256: '969ca245db8ea0410b11113b69fb5597f08c44ad04fefe151d84b9414a65de93',
    tagObject: 'baafbb0244419ff317d8a05cd1f824d33a87fa64',
    commit: '09815745f301ddf9e3c913f94959b2c873b2d876',
  }),
});

const ITEM_STATES = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED',
]);
const UPLOAD_STATES = new Set(['SUCCEEDED', 'IN_PROGRESS', 'FAILED', 'NOT_FOUND']);
const API_BASE = 'https://chromewebstore.googleapis.com';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const LEDGER_VISIBILITY_DELAYS_MS = Object.freeze([0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
export const LEDGER_CONFIRMATION_DELAY_MS = 1_000;
const LEGACY_ROLLOUT_TAG = 'v0.3.0';
const WORKFLOW_PATH = '.github/workflows/chrome-web-store.yml';
const GITHUB_ACTIONS_BOT_ID = 41898282;
export const SKIPPED_UPLOAD_RECOVERY_CONTRACT = Object.freeze({
  issueNumber: 9,
  runId: 32993251330,
  workflowSha: '06095bccb8b2fe00756b1cf34704a0d063f03c94',
  workflowPath: WORKFLOW_PATH,
  jobName: 'Protected v0.3.0 draft upload',
  steps: Object.freeze({
    ledger: Object.freeze({
      number: 9,
      name: 'Create and verify canonical pre-upload attempt ledger',
      status: 'completed',
      conclusion: 'failure',
    }),
    upload: Object.freeze({
      number: 10,
      name: 'Upload v0.3.0 draft without publishing',
      status: 'completed',
      conclusion: 'skipped',
    }),
    successLedger: Object.freeze({
      number: 11,
      name: 'Create and verify canonical synchronous upload-success ledger',
      status: 'completed',
      conclusion: 'skipped',
    }),
  }),
});
const ATTEMPT_MARKER_SCHEMA = 'eipeek-cws-publish-attempt/v1';
const ATTEMPT_MARKER_TITLE_PREFIX = '[EIPeek CWS pre-mutation attempt v1] SHA-256 ';
const ATTEMPT_MARKER_BODY_PREFIX = `<!-- ${ATTEMPT_MARKER_SCHEMA} -->
# Chrome Web Store pre-mutation attempt ledger

> **WARNING:** This public audit issue records a pre-mutation publish attempt. It does not prove the Chrome Web Store outcome. An explicit repository administrator edit or deletion is the only bypass, and requires Developer Dashboard verification first.

\`\`\`json
`;
const ATTEMPT_MARKER_BODY_SUFFIX = `
\`\`\`

This issue is never updated or deleted automatically. A matching open or closed issue blocks another mutation attempt for the same release SHA-256.
`;
const ROLLOUT_LEDGER_TYPES = Object.freeze({
  uploadAttempt: Object.freeze({
    schema: 'eipeek-cws-upload-attempt/v1',
    titlePrefix: '[EIPeek CWS upload attempt v1] ',
    heading: 'Chrome Web Store upload attempt ledger',
    warning: 'This records a pre-upload attempt. It does not prove that Chrome accepted the draft.',
  }),
  uploadSuccess: Object.freeze({
    schema: 'eipeek-cws-upload-success/v1',
    titlePrefix: '[EIPeek CWS upload success v1] ',
    heading: 'Chrome Web Store synchronous upload success ledger',
    warning: 'This records the exact synchronous API response proof that authorized the separate submission gate.',
  }),
  uploadResumeAttempt: Object.freeze({
    schema: 'eipeek-cws-upload-resume-attempt/v1',
    titlePrefix: '[EIPeek CWS upload resume attempt v1] ',
    heading: 'Chrome Web Store one-shot upload resume attempt ledger',
    warning: 'This records the one-shot pre-upload recovery claim and pinned proof that the original upload step was skipped.',
  }),
  recoveryUploadSuccess: Object.freeze({
    schema: 'eipeek-cws-upload-success/v2',
    titlePrefix: '[EIPeek CWS upload success v2] ',
    heading: 'Chrome Web Store recovered synchronous upload success ledger',
    warning: 'This records the exact synchronous API response proof for the one-shot skipped-upload recovery chain.',
  }),
  submitAttempt: Object.freeze({
    schema: 'eipeek-cws-submit-attempt/v1',
    titlePrefix: '[EIPeek CWS submit attempt v1] ',
    heading: 'Chrome Web Store review submission attempt ledger',
    warning: 'This records a pre-submit attempt. It does not prove the Chrome Web Store outcome.',
  }),
});
const ROLLOUT_LEDGER_TITLE_ROOT = '[EIPeek CWS ';
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseReleaseTag(tag) {
  invariant(typeof tag === 'string' && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag),
    'Release tag must use strict vMAJOR.MINOR.PATCH syntax');
  const version = tag.slice(1);
  parseChromeVersion(version, 3);
  return version;
}

export function parseChromeVersion(version, exactParts) {
  invariant(typeof version === 'string' && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version),
    `Invalid Chrome extension version: ${String(version)}`);
  const parts = version.split('.').map(Number);
  invariant(parts.length >= 1 && parts.length <= 4, 'Chrome versions require one to four components');
  if (exactParts !== undefined) invariant(parts.length === exactParts, `Version must have exactly ${exactParts} components`);
  invariant(parts.every((part) => Number.isSafeInteger(part) && part <= 65535),
    'Chrome version components must be integers from 0 through 65535');
  return parts;
}

export function compareChromeVersions(left, right) {
  const a = parseChromeVersion(left);
  const b = parseChromeVersion(right);
  for (let index = 0; index < 4; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function requirePublishConfirmation(tag, confirmation) {
  parseReleaseTag(tag);
  invariant(confirmation === `publish ${tag}`, `Publish confirmation must be exactly "publish ${tag}"`);
}

export function requireUploadConfirmation(tag, confirmation) {
  parseReleaseTag(tag);
  invariant(confirmation === `upload draft ${tag} only`,
    `Upload confirmation must be exactly "upload draft ${tag} only"`);
}

export function requireResumeUploadConfirmation(tag, confirmation) {
  parseReleaseTag(tag);
  requireManualPublishTag(tag);
  invariant(confirmation === `resume upload draft ${tag} after verified ledger-only failure`,
    `Resume-upload confirmation must be exactly "resume upload draft ${tag} after verified ledger-only failure"`);
}

export function requireSubmitConfirmation(tag, confirmation) {
  parseReleaseTag(tag);
  invariant(confirmation === `submit ${tag} after saving alarms justification`,
    `Submit confirmation must be exactly "submit ${tag} after saving alarms justification"`);
}

export function requireManualPublishTag(tag) {
  invariant(tag === LEGACY_ROLLOUT_TAG, 'Manual Chrome Web Store mutation is restricted to legacy release v0.3.0');
}

function validateRepositoryName(repository) {
  invariant(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    'Repository must have owner/name syntax');
  invariant(repository === EXPECTED_REPOSITORY, `Refusing unexpected repository ${repository}`);
}

function validateSha(sha, label = 'SHA') {
  invariant(typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha), `${label} must be a lowercase SHA-1`);
  return sha;
}

function validateSha256(digest, label = 'SHA-256') {
  invariant(typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest), `${label} must be lowercase hexadecimal`);
  return digest;
}

function validatePositiveId(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function parsePositiveId(value, label) {
  if (typeof value === 'number') return validatePositiveId(value, label);
  invariant(typeof value === 'string' && /^[1-9]\d*$/.test(value), `${label} must be a positive integer`);
  return validatePositiveId(Number(value), label);
}

function expectedAssetName(version) {
  return `eipeek-${version}-chrome.zip`;
}

export function validateReleaseRecord({ repository, repositoryRecord, release, tag, tagObject, commit }) {
  validateRepositoryName(repository);
  const version = parseReleaseTag(tag);
  invariant(isRecord(repositoryRecord), 'GitHub repository response is invalid');
  invariant(repositoryRecord.id === EXPECTED_REPOSITORY_ID, 'GitHub repository numeric ID does not match');
  invariant(repositoryRecord.full_name === EXPECTED_REPOSITORY, 'GitHub repository full name does not match');
  invariant(isRecord(repositoryRecord.owner) && repositoryRecord.owner.id === EXPECTED_OWNER_ID,
    'GitHub repository owner numeric ID does not match');
  invariant(isRecord(release), 'GitHub release response is invalid');
  validatePositiveId(release.id, 'Release ID');
  invariant(release.tag_name === tag, 'GitHub returned a release for a different tag');
  invariant(release.draft === false, 'Release must not be a draft');
  invariant(release.prerelease === false, 'Release must not be a prerelease');
  invariant(typeof release.published_at === 'string' && release.published_at.length > 0, 'Release must be published');
  validateSha(tagObject, 'Annotated tag object');
  validateSha(commit, 'Release commit');

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetName = expectedAssetName(version);
  const namedAssets = assets.filter((asset) => isRecord(asset) && asset.name === assetName);
  invariant(namedAssets.length === 1, `Release must contain exactly one asset named ${assetName}`);
  const asset = namedAssets[0];
  validatePositiveId(asset.id, 'Asset ID');
  invariant(Number.isSafeInteger(asset.size) && asset.size > 0, 'Asset size must be a positive integer');
  invariant(asset.state === 'uploaded', 'Release asset is not in uploaded state');

  let apiSha256;
  if (asset.digest !== null && asset.digest !== undefined) {
    invariant(typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest),
      'Release asset digest is not a SHA-256 digest');
    apiSha256 = asset.digest.slice('sha256:'.length);
  }

  const legacy = LEGACY_RELEASES[tag];
  if (legacy) {
    invariant(release.id === legacy.releaseId, 'Legacy release ID changed');
    invariant(asset.id === legacy.assetId, 'Legacy release asset ID changed');
    invariant(asset.size === legacy.assetSize, 'Legacy release asset size changed');
    invariant(tagObject === legacy.tagObject, 'Legacy annotated tag object changed');
    invariant(commit === legacy.commit, 'Legacy release commit changed');
    if (apiSha256 !== undefined) invariant(apiSha256 === legacy.sha256, 'Legacy API asset digest changed');
  } else {
    invariant(release.immutable === true,
      'Future GitHub releases must be immutable; enable immutable releases before publishing');
    invariant(apiSha256 !== undefined,
      'Future release assets must expose a GitHub SHA-256 digest; enable immutable releases before publishing');
  }

  return {
    tag,
    version,
    releaseId: release.id,
    assetId: asset.id,
    assetSize: asset.size,
    assetName,
    apiSha256,
    pinnedSha256: legacy?.sha256,
    immutable: release.immutable === true,
    tagObject,
    commit,
  };
}

function githubHeaders(token, accept = 'application/vnd.github+json') {
  invariant(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN is required');
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'eipeek-release-validator',
  };
}

async function responseError(response, label) {
  let detail = '';
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const errorMessage = parsed?.error?.message;
        const errorStatus = parsed?.error?.status;
        detail = typeof parsed?.message === 'string'
          ? parsed.message
          : [errorStatus, errorMessage].filter((part) => typeof part === 'string').join(': ');
      } catch {
        detail = body.slice(0, 500).replace(/[\r\n]+/g, ' ');
      }
    }
  } catch {
    // The status is still useful when an error response cannot be read.
  }
  return new Error(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

async function boundedRequest(fetchImpl, url, options, label, consume, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  invariant(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Request timeout must be positive');
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => consume(await fetchImpl(url, { ...options, signal: controller.signal })))(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function githubJson(fetchImpl, url, token, label) {
  return boundedRequest(fetchImpl, url, { headers: githubHeaders(token) }, label, async (response) => {
    if (!response.ok) throw await responseError(response, label);
    return response.json();
  });
}

function validateRunUrl(runUrl, repository) {
  invariant(typeof runUrl === 'string'
    && new RegExp(`^https://github\\.com/${repository.replace('/', '\\/')}/actions/runs/[1-9]\\d*$`).test(runUrl),
  'GitHub run URL is invalid');
  return runUrl;
}

export function formatAttemptMarker({ repository, tag, version, releaseId, assetId, commit, sha256, runUrl }) {
  validateRepositoryName(repository);
  const tagVersion = parseReleaseTag(tag);
  invariant(version === tagVersion, 'Release version does not match its tag');
  const payload = {
    schema: ATTEMPT_MARKER_SCHEMA,
    repository,
    releaseTag: tag,
    releaseVersion: version,
    releaseId: parsePositiveId(releaseId, 'Release ID'),
    assetId: parsePositiveId(assetId, 'Asset ID'),
    commit: validateSha(commit, 'Release commit'),
    sha256: validateSha256(sha256),
    runUrl: validateRunUrl(runUrl, repository),
  };
  return {
    title: `${ATTEMPT_MARKER_TITLE_PREFIX}${payload.sha256}`,
    body: `${ATTEMPT_MARKER_BODY_PREFIX}${JSON.stringify(payload, null, 2)}${ATTEMPT_MARKER_BODY_SUFFIX}`,
    payload,
  };
}

export function validateAttemptMarker(title, body) {
  invariant(typeof title === 'string' && title.startsWith(ATTEMPT_MARKER_TITLE_PREFIX),
    'Attempt ledger issue title is not recognized');
  invariant(typeof body === 'string' && body.startsWith(ATTEMPT_MARKER_BODY_PREFIX)
    && body.endsWith(ATTEMPT_MARKER_BODY_SUFFIX), 'Attempt ledger issue body is not recognized');
  const json = body.slice(ATTEMPT_MARKER_BODY_PREFIX.length, -ATTEMPT_MARKER_BODY_SUFFIX.length);
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error('Attempt ledger issue body has invalid JSON');
  }
  invariant(isRecord(payload) && Object.keys(payload).length === 9, 'Attempt ledger payload is invalid');
  invariant(payload.schema === ATTEMPT_MARKER_SCHEMA, 'Attempt ledger schema is invalid');
  const marker = formatAttemptMarker({
    repository: payload.repository,
    tag: payload.releaseTag,
    version: payload.releaseVersion,
    releaseId: payload.releaseId,
    assetId: payload.assetId,
    commit: payload.commit,
    sha256: payload.sha256,
    runUrl: payload.runUrl,
  });
  invariant(marker.title === title && marker.body === body, 'Attempt ledger issue is not in canonical form');
  return marker.payload;
}

function validateAttemptIssue(issue, repository, marker, label, requireOpen = false) {
  invariant(isRecord(issue) && !Object.hasOwn(issue, 'pull_request'), `${label} response is not a repository issue`);
  const number = parsePositiveId(issue.number, `${label} issue number`);
  invariant(issue.title === marker.title && issue.body === marker.body, `${label} issue marker does not match`);
  invariant(issue.state === 'open' || (!requireOpen && issue.state === 'closed'), `${label} issue state is invalid`);
  const issueUrl = `https://github.com/${repository}/issues/${number}`;
  invariant(issue.html_url === issueUrl, `${label} issue URL does not match`);
  validateAttemptMarker(issue.title, issue.body);
  return { number, issueUrl };
}

async function githubIssueJson(fetchImpl, url, token, label, {
  method = 'GET', body, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const headers = githubHeaders(token);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return boundedRequest(fetchImpl, url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, label, async (response) => {
    if (!response.ok) throw await responseError(response, label);
    try {
      return await response.json();
    } catch {
      throw new Error(`${label} returned a non-JSON success response`);
    }
  }, requestTimeoutMs);
}

export async function claimPublishAttempt({
  repository = EXPECTED_REPOSITORY,
  tag,
  version,
  releaseId,
  assetId,
  commit,
  sha256,
  runUrl,
  token,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const marker = formatAttemptMarker({ repository, tag, version, releaseId, assetId, commit, sha256, runUrl });
  const apiRoot = `https://api.github.com/repos/${repository}`;
  for (let page = 1; ; page += 1) {
    const issues = await githubIssueJson(fetchImpl,
      `${apiRoot}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
      token, 'Attempt ledger issue list', { requestTimeoutMs });
    invariant(Array.isArray(issues) && issues.length <= 100, 'Attempt ledger issue list response is invalid');
    for (const issue of issues) {
      if (!isRecord(issue) || Object.hasOwn(issue, 'pull_request') || issue.title !== marker.title) continue;
      try {
        validateAttemptMarker(issue.title, issue.body);
      } catch (error) {
        throw new Error(`Matching attempt ledger issue is malformed; refusing to mutate: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new Error(`A pre-mutation attempt ledger already exists for SHA-256 ${marker.payload.sha256}; inspect the Developer Dashboard`);
    }
    if (issues.length < 100) break;
  }

  const created = await githubIssueJson(fetchImpl, `${apiRoot}/issues`, token, 'Attempt ledger issue creation', {
    method: 'POST', body: { title: marker.title, body: marker.body }, requestTimeoutMs,
  });
  const creation = validateAttemptIssue(created, repository, marker, 'Created attempt ledger', true);
  const fetched = await githubIssueJson(fetchImpl, `${apiRoot}/issues/${creation.number}`, token,
    'Attempt ledger issue verification', { requestTimeoutMs });
  const verified = validateAttemptIssue(fetched, repository, marker, 'Verified attempt ledger');
  return { issueNumber: verified.number, issueUrl: verified.issueUrl, marker };
}

function rolloutSharedIdentity({
  repository = EXPECTED_REPOSITORY,
  repositoryId = EXPECTED_REPOSITORY_ID,
  tag,
  version,
  releaseId,
  assetId,
  assetName,
  assetSize,
  tagObject,
  commit,
  sha256,
  publisherId,
  extensionId,
}) {
  validateRepositoryName(repository);
  invariant(parsePositiveId(repositoryId, 'Repository ID') === EXPECTED_REPOSITORY_ID,
    'Repository numeric ID does not match');
  invariant(tag === LEGACY_ROLLOUT_TAG, 'The staged ledger is restricted to v0.3.0');
  const tagVersion = parseReleaseTag(tag);
  invariant(version === tagVersion, 'Release version does not match its tag');
  const checkedReleaseId = parsePositiveId(releaseId, 'Release ID');
  const checkedAssetId = parsePositiveId(assetId, 'Asset ID');
  const checkedAssetSize = parsePositiveId(assetSize, 'Asset size');
  invariant(assetName === expectedAssetName(version), 'Release asset name does not match its version');
  validatePublisherId(publisherId);
  validateExtensionId(extensionId);
  return {
    repository,
    repositoryId: EXPECTED_REPOSITORY_ID,
    releaseTag: tag,
    releaseVersion: version,
    releaseId: checkedReleaseId,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    assetId: checkedAssetId,
    assetName,
    assetSize: checkedAssetSize,
    assetUrl: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
    tagObject: validateSha(tagObject, 'Annotated tag object'),
    commit: validateSha(commit, 'Release commit'),
    commitUrl: `https://github.com/${repository}/commit/${commit}`,
    sha256: validateSha256(sha256),
    publisherId,
    extensionId,
    cwsItemName: `publishers/${publisherId}/items/${extensionId}`,
    cwsStatusUrl: `${API_BASE}/v2/publishers/${publisherId}/items/${extensionId}:fetchStatus`,
  };
}

function rolloutRunIdentity({ repository, runId, runAttempt, runUrl, workflowRef, workflowSha }) {
  const checkedRunId = parsePositiveId(runId, 'Workflow run ID');
  const checkedRunAttempt = parsePositiveId(runAttempt, 'Workflow run attempt');
  const expectedRunUrl = `https://github.com/${repository}/actions/runs/${checkedRunId}`;
  invariant(runUrl === expectedRunUrl, 'Workflow run URL does not match its ID');
  const expectedWorkflowRef = `${repository}/${WORKFLOW_PATH}@refs/heads/main`;
  invariant(workflowRef === expectedWorkflowRef, 'Workflow ref must identify the main-branch Chrome Web Store workflow');
  const checkedWorkflowSha = validateSha(workflowSha, 'Workflow SHA');
  return {
    runId: checkedRunId,
    runAttempt: checkedRunAttempt,
    runUrl,
    workflowRef,
    workflowSha: checkedWorkflowSha,
    workflowUrl: `https://github.com/${repository}/blob/${checkedWorkflowSha}/${WORKFLOW_PATH}`,
  };
}

function assertExactObjectKeys(value, expectedKeys, label) {
  invariant(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields are invalid`);
}

const RECOVERY_RUN_EVIDENCE_KEYS = Object.freeze([
  'repository', 'repositoryId', 'runId', 'runAttempt', 'runUrl', 'apiUrl', 'workflowPath',
  'workflowSha', 'headSha', 'headBranch', 'event', 'status', 'conclusion',
]);
const RECOVERY_JOB_EVIDENCE_KEYS = Object.freeze([
  'jobsTotalCount', 'jobId', 'apiUrl', 'jobUrl', 'jobName', 'status', 'conclusion',
  'headSha', 'runId', 'runAttempt', 'steps',
]);
const RECOVERY_STEP_EVIDENCE_KEYS = Object.freeze(['number', 'name', 'status', 'conclusion']);

function canonicalRecoveryEvidence(input) {
  assertExactObjectKeys(input, ['run', 'job'], 'Recovery evidence');
  assertExactObjectKeys(input.run, RECOVERY_RUN_EVIDENCE_KEYS, 'Recovery run evidence');
  const repository = input.run.repository;
  validateRepositoryName(repository);
  invariant(parsePositiveId(input.run.repositoryId, 'Recovery repository ID') === EXPECTED_REPOSITORY_ID,
    'Recovery repository numeric ID does not match');
  const runId = parsePositiveId(input.run.runId, 'Prior workflow run ID');
  invariant(runId === SKIPPED_UPLOAD_RECOVERY_CONTRACT.runId,
    'Recovery run evidence ID is not recognized');
  const runAttempt = parsePositiveId(input.run.runAttempt, 'Prior workflow run attempt');
  invariant(runAttempt === 1, 'Skipped-upload recovery recognizes only prior run attempt 1');
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  invariant(input.run.runUrl === runUrl, 'Recovery run evidence URL does not match');
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const runApiUrl = `${apiRoot}/actions/runs/${runId}`;
  invariant(input.run.apiUrl === runApiUrl, 'Recovery run evidence API URL does not match');
  invariant(input.run.workflowPath === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowPath,
    'Recovery run evidence workflow path is not recognized');
  invariant(input.run.workflowSha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    'Recovery run evidence workflow SHA is not recognized');
  invariant(input.run.headSha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    'Recovery run evidence head SHA is not recognized');
  invariant(input.run.headBranch === 'main', 'Recovery run evidence branch must be main');
  invariant(input.run.event === 'workflow_dispatch', 'Recovery run evidence event must be workflow_dispatch');
  invariant(input.run.status === 'completed', 'Recovery run evidence must be completed');
  invariant(input.run.conclusion === 'failure', 'Recovery run evidence must have failed');

  assertExactObjectKeys(input.job, RECOVERY_JOB_EVIDENCE_KEYS, 'Recovery job evidence');
  const jobsTotalCount = parsePositiveId(input.job.jobsTotalCount, 'Prior run job count');
  const jobId = parsePositiveId(input.job.jobId, 'Prior upload job ID');
  const jobApiUrl = `${apiRoot}/actions/jobs/${jobId}`;
  invariant(input.job.apiUrl === jobApiUrl, 'Recovery job evidence API URL does not match');
  const acceptedJobUrls = new Set([
    `${runUrl}/job/${jobId}`,
    `https://github.com/${repository}/runs/${jobId}`,
  ]);
  invariant(acceptedJobUrls.has(input.job.jobUrl), 'Recovery job evidence URL does not match');
  invariant(input.job.jobName === SKIPPED_UPLOAD_RECOVERY_CONTRACT.jobName,
    'Recovery job evidence name is not recognized');
  invariant(input.job.status === 'completed', 'Recovery job evidence must be completed');
  invariant(input.job.conclusion === 'failure', 'Recovery job evidence must have failed');
  invariant(input.job.headSha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    'Recovery job evidence head SHA is not recognized');
  invariant(input.job.runId === runId && input.job.runAttempt === runAttempt,
    'Recovery job evidence does not match its run');
  invariant(Array.isArray(input.job.steps) && input.job.steps.length === 3,
    'Recovery job evidence must contain exactly the three pinned steps');
  const expectedSteps = Object.values(SKIPPED_UPLOAD_RECOVERY_CONTRACT.steps);
  const steps = input.job.steps.map((step, index) => {
    assertExactObjectKeys(step, RECOVERY_STEP_EVIDENCE_KEYS, 'Recovery step evidence');
    const expected = expectedSteps[index];
    invariant(step.number === expected.number && step.name === expected.name
      && step.status === expected.status && step.conclusion === expected.conclusion,
    `Recovery step ${expected.number} evidence does not match the pinned contract`);
    return { number: step.number, name: step.name, status: step.status, conclusion: step.conclusion };
  });
  return {
    run: {
      repository,
      repositoryId: EXPECTED_REPOSITORY_ID,
      runId,
      runAttempt,
      runUrl,
      apiUrl: runApiUrl,
      workflowPath: SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowPath,
      workflowSha: SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
      headSha: SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
      headBranch: 'main',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'failure',
    },
    job: {
      jobsTotalCount,
      jobId,
      apiUrl: jobApiUrl,
      jobUrl: input.job.jobUrl,
      jobName: SKIPPED_UPLOAD_RECOVERY_CONTRACT.jobName,
      status: 'completed',
      conclusion: 'failure',
      headSha: SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
      runId,
      runAttempt,
      steps,
    },
  };
}

function rolloutBodyPrefix(type) {
  const definition = ROLLOUT_LEDGER_TYPES[type];
  invariant(definition !== undefined, `Unknown rollout ledger type ${String(type)}`);
  return `<!-- ${definition.schema} -->\n# ${definition.heading}\n\n> **WARNING:** ${definition.warning}\n\n\`\`\`json\n`;
}

function rolloutBodySuffix(type) {
  const proof = type === 'uploadSuccess' || type === 'recoveryUploadSuccess';
  return `\n\`\`\`\n\nThis ${proof ? 'proof' : 'attempt'} issue is never edited, closed, or deleted automatically.\n`;
}

function rolloutLinks(type, input, shared) {
  if (type === 'uploadAttempt') return {};
  const uploadAttemptIssueNumber = parsePositiveId(input.uploadAttemptIssueNumber, 'Upload attempt issue number');
  const uploadAttemptIssueUrl = `https://github.com/${shared.repository}/issues/${uploadAttemptIssueNumber}`;
  invariant(input.uploadAttemptIssueUrl === uploadAttemptIssueUrl, 'Upload attempt issue URL does not match');
  const uploadAttemptLink = { uploadAttemptIssueNumber, uploadAttemptIssueUrl };
  if (type === 'uploadResumeAttempt') {
    invariant(uploadAttemptIssueNumber === SKIPPED_UPLOAD_RECOVERY_CONTRACT.issueNumber,
      'Upload resume is restricted to the reviewed original upload-attempt issue');
    return { ...uploadAttemptLink, priorEvidence: canonicalRecoveryEvidence(input.priorEvidence) };
  }
  if (type === 'uploadSuccess') {
    invariant(input.uploadResponseItemId === shared.extensionId,
      'Upload success proof item ID does not match the CWS target');
    invariant(input.uploadResponseName === shared.cwsItemName,
      'Upload success proof item name does not match the CWS target');
    invariant(input.uploadState === 'SUCCEEDED', 'Upload success proof must record SUCCEEDED');
    invariant(input.crxVersion === shared.releaseVersion,
      'Upload success proof CRX version does not match the release');
    return {
      ...uploadAttemptLink,
      uploadResponseItemId: input.uploadResponseItemId,
      uploadResponseName: input.uploadResponseName,
      uploadState: input.uploadState,
      crxVersion: input.crxVersion,
    };
  }
  if (type === 'recoveryUploadSuccess') {
    invariant(uploadAttemptIssueNumber === SKIPPED_UPLOAD_RECOVERY_CONTRACT.issueNumber,
      'Recovery upload success is restricted to the reviewed original upload-attempt issue');
    const uploadResumeIssueNumber = parsePositiveId(input.uploadResumeIssueNumber, 'Upload resume issue number');
    const uploadResumeIssueUrl = `https://github.com/${shared.repository}/issues/${uploadResumeIssueNumber}`;
    invariant(input.uploadResumeIssueUrl === uploadResumeIssueUrl, 'Upload resume issue URL does not match');
    invariant(input.uploadResponseItemId === shared.extensionId,
      'Recovery upload success proof item ID does not match the CWS target');
    invariant(input.uploadResponseName === shared.cwsItemName,
      'Recovery upload success proof item name does not match the CWS target');
    invariant(input.uploadState === 'SUCCEEDED', 'Recovery upload success proof must record SUCCEEDED');
    invariant(input.crxVersion === shared.releaseVersion,
      'Recovery upload success proof CRX version does not match the release');
    return {
      ...uploadAttemptLink,
      uploadResumeIssueNumber,
      uploadResumeIssueUrl,
      uploadResponseItemId: input.uploadResponseItemId,
      uploadResponseName: input.uploadResponseName,
      uploadState: input.uploadState,
      crxVersion: input.crxVersion,
    };
  }
  const uploadSuccessIssueNumber = parsePositiveId(input.uploadSuccessIssueNumber, 'Upload success issue number');
  const uploadSuccessIssueUrl = `https://github.com/${shared.repository}/issues/${uploadSuccessIssueNumber}`;
  invariant(input.uploadSuccessIssueUrl === uploadSuccessIssueUrl, 'Upload success issue URL does not match');
  return { ...uploadAttemptLink, uploadSuccessIssueNumber, uploadSuccessIssueUrl };
}

export function formatRolloutLedgerMarker(type, input) {
  const definition = ROLLOUT_LEDGER_TYPES[type];
  invariant(definition !== undefined, `Unknown rollout ledger type ${String(type)}`);
  const shared = rolloutSharedIdentity(input);
  const operation = type === 'submitAttempt'
    ? 'submit'
    : type === 'uploadResumeAttempt' || type === 'recoveryUploadSuccess'
      ? 'resume-upload'
      : 'upload';
  const payload = {
    schema: definition.schema,
    operation,
    ...shared,
    ...rolloutRunIdentity({ repository: shared.repository, ...input }),
    ...rolloutLinks(type, input, shared),
  };
  const title = `${definition.titlePrefix}${shared.releaseTag} SHA-256 ${shared.sha256}`;
  const body = `${rolloutBodyPrefix(type)}${JSON.stringify(payload, null, 2)}${rolloutBodySuffix(type)}`;
  return { type, title, body, payload };
}

function rolloutTypeFromTitle(title) {
  invariant(typeof title === 'string', 'Rollout ledger issue title is invalid');
  for (const [type, definition] of Object.entries(ROLLOUT_LEDGER_TYPES)) {
    if (title.startsWith(definition.titlePrefix)) return type;
  }
  if (title.startsWith(ROLLOUT_LEDGER_TITLE_ROOT)
    && /(?:upload attempt|upload resume attempt|upload success|submit attempt)/.test(title)) {
    throw new Error('Rollout ledger issue title is malformed');
  }
  return undefined;
}

export function validateRolloutLedgerMarker(title, body) {
  const type = rolloutTypeFromTitle(title);
  invariant(type !== undefined, 'Rollout ledger issue title is not recognized');
  const prefix = rolloutBodyPrefix(type);
  const suffix = rolloutBodySuffix(type);
  invariant(typeof body === 'string' && body.startsWith(prefix) && body.endsWith(suffix),
    'Rollout ledger issue body is not recognized');
  let payload;
  try {
    payload = JSON.parse(body.slice(prefix.length, -suffix.length));
  } catch {
    throw new Error('Rollout ledger issue body has invalid JSON');
  }
  invariant(isRecord(payload), 'Rollout ledger payload is invalid');
  const marker = formatRolloutLedgerMarker(type, {
    repository: payload.repository,
    repositoryId: payload.repositoryId,
    tag: payload.releaseTag,
    version: payload.releaseVersion,
    releaseId: payload.releaseId,
    assetId: payload.assetId,
    assetName: payload.assetName,
    assetSize: payload.assetSize,
    tagObject: payload.tagObject,
    commit: payload.commit,
    sha256: payload.sha256,
    publisherId: payload.publisherId,
    extensionId: payload.extensionId,
    runId: payload.runId,
    runAttempt: payload.runAttempt,
    runUrl: payload.runUrl,
    workflowRef: payload.workflowRef,
    workflowSha: payload.workflowSha,
    uploadAttemptIssueNumber: payload.uploadAttemptIssueNumber,
    uploadAttemptIssueUrl: payload.uploadAttemptIssueUrl,
    uploadResumeIssueNumber: payload.uploadResumeIssueNumber,
    uploadResumeIssueUrl: payload.uploadResumeIssueUrl,
    uploadSuccessIssueNumber: payload.uploadSuccessIssueNumber,
    uploadSuccessIssueUrl: payload.uploadSuccessIssueUrl,
    priorEvidence: payload.priorEvidence,
    uploadResponseItemId: payload.uploadResponseItemId,
    uploadResponseName: payload.uploadResponseName,
    uploadState: payload.uploadState,
    crxVersion: payload.crxVersion,
  });
  invariant(marker.title === title && marker.body === body, 'Rollout ledger issue is not in canonical form');
  return marker;
}

function validateRolloutIssue(issue, repository, marker, label, requireOpen = false) {
  invariant(isRecord(issue) && !Object.hasOwn(issue, 'pull_request'), `${label} response is not a repository issue`);
  const number = parsePositiveId(issue.number, `${label} issue number`);
  invariant(issue.title === marker.title && issue.body === marker.body, `${label} issue marker does not match`);
  invariant(issue.state === 'open' || (!requireOpen && issue.state === 'closed'), `${label} issue state is invalid`);
  const issueUrl = `https://github.com/${repository}/issues/${number}`;
  invariant(issue.html_url === issueUrl, `${label} issue URL does not match`);
  invariant(isRecord(issue.user)
    && issue.user.login === 'github-actions[bot]'
    && issue.user.id === GITHUB_ACTIONS_BOT_ID
    && issue.user.type === 'Bot',
  `${label} issue was not created by the authenticated GitHub Actions bot`);
  validateRolloutLedgerMarker(issue.title, issue.body);
  return { number, issueUrl, state: issue.state, marker };
}

const ROLLOUT_SHARED_KEYS = Object.freeze([
  'repository', 'repositoryId', 'releaseTag', 'releaseVersion', 'releaseId', 'releaseUrl',
  'assetId', 'assetName', 'assetSize', 'assetUrl', 'tagObject', 'commit', 'commitUrl', 'sha256',
  'publisherId', 'extensionId', 'cwsItemName', 'cwsStatusUrl',
]);

function assertRolloutIdentity(payload, expected) {
  for (const key of ROLLOUT_SHARED_KEYS) {
    invariant(payload[key] === expected[key], `Rollout ledger ${key} does not match the approved release`);
  }
}

const ROLLOUT_RUN_KEYS = Object.freeze([
  'runId', 'runAttempt', 'runUrl', 'workflowRef', 'workflowSha', 'workflowUrl',
]);

function assertSameRolloutRun(left, right, label) {
  for (const key of ROLLOUT_RUN_KEYS) {
    invariant(left[key] === right[key], `${label} ${key} does not match`);
  }
}

function assertResumeEvidenceMatchesAttempt(resume, attempt) {
  const evidence = resume.marker.payload.priorEvidence;
  const prior = evidence.run;
  const attemptPayload = attempt.marker.payload;
  invariant(prior.runId === attemptPayload.runId
    && prior.runAttempt === attemptPayload.runAttempt
    && prior.runUrl === attemptPayload.runUrl
    && prior.workflowSha === attemptPayload.workflowSha,
  'Upload resume evidence does not identify the exact original upload attempt run');
  invariant(resume.marker.payload.runAttempt === 1,
    'Upload resume must be claimed by workflow run attempt 1');
  invariant(resume.marker.payload.runId !== attemptPayload.runId,
    'Upload resume must run separately from the original failed upload run');
}

function assertOpenPinnedRecoveryAttempt(attempt) {
  invariant(attempt.number === SKIPPED_UPLOAD_RECOVERY_CONTRACT.issueNumber,
    'Skipped-upload recovery is restricted to the reviewed original upload-attempt issue');
  invariant(attempt.marker.payload.runId === SKIPPED_UPLOAD_RECOVERY_CONTRACT.runId,
    'Skipped-upload recovery is restricted to the reviewed original workflow run');
  invariant(attempt.state === 'open',
    'The original upload-attempt issue must remain open throughout recovery');
}

async function scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs }) {
  const expected = rolloutSharedIdentity(identity);
  const records = {
    uploadAttempt: [],
    uploadSuccess: [],
    uploadResumeAttempt: [],
    recoveryUploadSuccess: [],
    submitAttempt: [],
  };
  const apiRoot = `https://api.github.com/repos/${expected.repository}`;
  for (let page = 1; ; page += 1) {
    const issues = await githubIssueJson(fetchImpl,
      `${apiRoot}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
      token, 'Staged rollout ledger issue list', { requestTimeoutMs });
    invariant(Array.isArray(issues) && issues.length <= 100, 'Staged rollout ledger issue list response is invalid');
    for (const issue of issues) {
      if (!isRecord(issue) || Object.hasOwn(issue, 'pull_request')) continue;
      let type;
      try {
        type = rolloutTypeFromTitle(issue.title);
      } catch (error) {
        throw new Error(`Malformed staged rollout ledger issue found; refusing to continue: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (type === undefined && typeof issue.body === 'string'
        && /^<!-- eipeek-cws-(?:upload-attempt|upload-resume-attempt|upload-success|submit-attempt)\//.test(issue.body)) {
        throw new Error('Malformed staged rollout ledger issue found; schema body has no canonical title');
      }
      if (type === undefined) continue;
      let marker;
      try {
        marker = validateRolloutLedgerMarker(issue.title, issue.body);
        assertRolloutIdentity(marker.payload, expected);
      } catch (error) {
        throw new Error(`Malformed or mismatched staged rollout ledger issue found; refusing to continue: ${error instanceof Error ? error.message : String(error)}`);
      }
      records[type].push(validateRolloutIssue(issue, expected.repository, marker, 'Staged rollout ledger'));
    }
    if (issues.length < 100) break;
  }
  for (const [type, found] of Object.entries(records)) {
    invariant(found.length <= 1, `Duplicate ${type} staged rollout ledger issues found`);
  }
  invariant(records.uploadSuccess.length + records.recoveryUploadSuccess.length <= 1,
    'Both normal and recovery upload-success staged rollout ledgers exist');
  const attempt = records.uploadAttempt[0];
  const resume = records.uploadResumeAttempt[0];
  const normalSuccess = records.uploadSuccess[0];
  const recoverySuccess = records.recoveryUploadSuccess[0];
  const success = normalSuccess ?? recoverySuccess;
  const submit = records.submitAttempt[0];
  if (resume) {
    invariant(attempt !== undefined, 'Upload resume ledger exists without its original upload attempt ledger');
    invariant(resume.marker.payload.uploadAttemptIssueNumber === attempt.number
      && resume.marker.payload.uploadAttemptIssueUrl === attempt.issueUrl,
    'Upload resume ledger does not link the exact original upload attempt ledger');
    assertResumeEvidenceMatchesAttempt(resume, attempt);
    assertOpenPinnedRecoveryAttempt(attempt);
  }
  if (normalSuccess) {
    invariant(attempt !== undefined, 'Upload success ledger exists without its upload attempt ledger');
    invariant(resume === undefined, 'Upload success/v1 cannot coexist with an upload resume ledger');
    invariant(normalSuccess.marker.payload.uploadAttemptIssueNumber === attempt.number
      && normalSuccess.marker.payload.uploadAttemptIssueUrl === attempt.issueUrl,
    'Upload success ledger does not link the exact upload attempt ledger');
    assertSameRolloutRun(normalSuccess.marker.payload, attempt.marker.payload,
      'Upload success ledger run identity');
  }
  if (recoverySuccess) {
    invariant(attempt !== undefined && resume !== undefined,
      'Upload success/v2 exists without the exact upload attempt and resume ledgers');
    invariant(recoverySuccess.marker.payload.uploadAttemptIssueNumber === attempt.number
      && recoverySuccess.marker.payload.uploadAttemptIssueUrl === attempt.issueUrl
      && recoverySuccess.marker.payload.uploadResumeIssueNumber === resume.number
      && recoverySuccess.marker.payload.uploadResumeIssueUrl === resume.issueUrl,
    'Upload success/v2 does not link the exact upload attempt and resume ledgers');
    assertSameRolloutRun(recoverySuccess.marker.payload, resume.marker.payload,
      'Upload success/v2 run identity');
  }
  if (submit) {
    invariant(attempt !== undefined && success !== undefined,
      'Submit attempt ledger exists without both verified upload ledgers');
    invariant(submit.marker.payload.uploadAttemptIssueNumber === attempt.number
      && submit.marker.payload.uploadAttemptIssueUrl === attempt.issueUrl
      && submit.marker.payload.uploadSuccessIssueNumber === success.number
      && submit.marker.payload.uploadSuccessIssueUrl === success.issueUrl,
    'Submit attempt ledger does not link the exact upload ledgers');
  }
  return { expected, records, apiRoot };
}

const COMPLETED_CONCLUSIONS = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required',
  'startup_failure', 'stale',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  invariant(value === null || ['string', 'number', 'boolean'].includes(typeof value),
    'GitHub Actions response contains a non-JSON value');
  return JSON.stringify(value);
}

function validateRecoveryRunResponse(run, attemptPayload, label) {
  invariant(isRecord(run), `${label} response is invalid`);
  const runId = validatePositiveId(run.id, `${label} run ID`);
  invariant(runId === attemptPayload.runId, `${label} run ID does not match the upload attempt`);
  const runAttempt = validatePositiveId(run.run_attempt, `${label} run attempt`);
  invariant(runAttempt === attemptPayload.runAttempt, `${label} run attempt does not match the upload attempt`);
  invariant(run.url === `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${runId}`,
    `${label} API URL does not match`);
  invariant(run.html_url === attemptPayload.runUrl, `${label} HTML URL does not match the upload attempt`);
  invariant(isRecord(run.repository)
    && run.repository.id === EXPECTED_REPOSITORY_ID
    && run.repository.full_name === EXPECTED_REPOSITORY,
  `${label} repository identity does not match`);
  invariant(run.path === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowPath,
    `${label} workflow path does not match the pinned contract`);
  invariant(run.head_branch === 'main', `${label} branch must be main`);
  invariant(run.event === 'workflow_dispatch', `${label} event must be workflow_dispatch`);
  invariant(run.status === 'completed', `${label} is not completed`);
  invariant(run.conclusion === 'failure', `${label} did not conclude with failure`);
  invariant(run.head_sha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    `${label} head SHA does not match the pinned workflow SHA`);
  if (Object.hasOwn(run, 'workflow_sha')) {
    invariant(run.workflow_sha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
      `${label} workflow SHA does not match the pinned contract`);
  }
  return {
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runId,
    runAttempt,
    runUrl: attemptPayload.runUrl,
    apiUrl: run.url,
    workflowPath: SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowPath,
    workflowSha: attemptPayload.workflowSha,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
  };
}

function validateListedJob(job, runId, runAttempt, seenIds) {
  invariant(isRecord(job), 'Prior run job list contains an invalid job');
  const jobId = validatePositiveId(job.id, 'Prior run job ID');
  invariant(!seenIds.has(jobId), `Prior run job list contains duplicate job ID ${jobId}`);
  seenIds.add(jobId);
  invariant(typeof job.name === 'string' && job.name.length > 0, 'Prior run job name is invalid');
  invariant(job.status === 'completed', `Prior run job ${job.name} is not completed`);
  invariant(typeof job.conclusion === 'string' && COMPLETED_CONCLUSIONS.has(job.conclusion),
    `Prior run job ${job.name} conclusion is null or unrecognized`);
  invariant(job.run_id === runId && job.run_attempt === runAttempt,
    `Prior run job ${job.name} does not match the exact run attempt`);
  invariant(job.head_sha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    `Prior run job ${job.name} head SHA does not match`);
  invariant(job.head_branch === 'main', `Prior run job ${job.name} branch does not match`);
  invariant(job.run_url === `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${runId}`,
    `Prior run job ${job.name} run URL does not match`);
  invariant(job.url === `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/jobs/${jobId}`,
    `Prior run job ${job.name} API URL does not match`);
  invariant(typeof job.html_url === 'string' && new Set([
    `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${runId}/job/${jobId}`,
    `https://github.com/${EXPECTED_REPOSITORY}/runs/${jobId}`,
  ]).has(job.html_url), `Prior run job ${job.name} HTML URL does not match`);
  return jobId;
}

async function listRecoveryRunJobs({ apiRoot, runId, runAttempt, token, fetchImpl, requestTimeoutMs }) {
  const jobs = [];
  const seenIds = new Set();
  let totalCount;
  for (let page = 1; ; page += 1) {
    const response = await githubIssueJson(fetchImpl,
      `${apiRoot}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      token, 'Prior run attempt job list', { requestTimeoutMs });
    invariant(isRecord(response), 'Prior run attempt job list response is invalid');
    const pageTotal = response.total_count;
    invariant(Number.isSafeInteger(pageTotal) && pageTotal >= 0,
      'Prior run attempt job list total_count is invalid');
    if (totalCount === undefined) totalCount = pageTotal;
    invariant(pageTotal === totalCount, 'Prior run attempt job pagination count changed');
    invariant(Array.isArray(response.jobs) && response.jobs.length <= 100,
      'Prior run attempt job page is invalid');
    const remaining = totalCount - jobs.length;
    invariant(remaining >= 0, 'Prior run attempt job pagination exceeded total_count');
    const expectedPageLength = Math.min(100, remaining);
    invariant(response.jobs.length === expectedPageLength,
      'Prior run attempt job pagination does not match total_count');
    for (const job of response.jobs) {
      validateListedJob(job, runId, runAttempt, seenIds);
      jobs.push(job);
    }
    if (jobs.length === totalCount) break;
  }
  invariant(jobs.length === totalCount, 'Prior run attempt job pagination is incomplete');
  return { jobs, totalCount };
}

function validateRecoveryJobSteps(job) {
  invariant(job.name === SKIPPED_UPLOAD_RECOVERY_CONTRACT.jobName,
    'Prior upload job name does not match the pinned recovery contract');
  invariant(job.status === 'completed' && job.conclusion === 'failure',
    'Prior upload job must be completed with failure');
  invariant(Array.isArray(job.steps) && job.steps.length > 0, 'Prior upload job steps are missing');
  const numbers = new Set();
  const names = new Set();
  let previousNumber = 0;
  for (const step of job.steps) {
    invariant(isRecord(step), 'Prior upload job contains an invalid step');
    const number = validatePositiveId(step.number, 'Prior upload job step number');
    invariant(number > previousNumber, 'Prior upload job steps are duplicated or reordered');
    previousNumber = number;
    invariant(!numbers.has(number), `Prior upload job contains duplicate step number ${number}`);
    numbers.add(number);
    invariant(typeof step.name === 'string' && step.name.length > 0,
      `Prior upload job step ${number} name is invalid`);
    invariant(!names.has(step.name), `Prior upload job contains duplicate step name ${step.name}`);
    names.add(step.name);
    invariant(step.status === 'completed', `Prior upload job step ${number} is not completed`);
    invariant(typeof step.conclusion === 'string' && COMPLETED_CONCLUSIONS.has(step.conclusion),
      `Prior upload job step ${number} conclusion is null or unrecognized`);
  }
  const criticalSteps = Object.values(SKIPPED_UPLOAD_RECOVERY_CONTRACT.steps).map((expected) => {
    const numbered = job.steps.filter((step) => step.number === expected.number);
    const named = job.steps.filter((step) => step.name === expected.name);
    invariant(numbered.length === 1 && named.length === 1 && numbered[0] === named[0],
      `Prior upload job step ${expected.number} is missing, renamed, duplicated, or reordered`);
    const actual = numbered[0];
    invariant(actual.status === expected.status && actual.conclusion === expected.conclusion,
      `Prior upload job step ${expected.number} did not conclusively ${expected.conclusion === 'skipped' ? 'skip' : 'fail'}`);
    return {
      number: actual.number,
      name: actual.name,
      status: actual.status,
      conclusion: actual.conclusion,
    };
  });
  return criticalSteps;
}

export async function verifySkippedUploadRecoveryEvidence({
  uploadAttempt,
  token,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  invariant(isRecord(uploadAttempt) && isRecord(uploadAttempt.marker),
    'A scanned canonical upload-attempt ledger is required for recovery proof');
  invariant(uploadAttempt.marker.type === 'uploadAttempt',
    'Recovery proof requires an upload-attempt/v1 ledger');
  const issueNumber = parsePositiveId(uploadAttempt.number, 'Upload attempt issue number');
  invariant(issueNumber === SKIPPED_UPLOAD_RECOVERY_CONTRACT.issueNumber,
    'Upload attempt issue number has no reviewed skipped-upload recovery contract');
  invariant(uploadAttempt.state === 'open',
    'The original upload-attempt issue must remain open for skipped-upload recovery');
  invariant(uploadAttempt.issueUrl === `https://github.com/${EXPECTED_REPOSITORY}/issues/${issueNumber}`,
    'Upload attempt issue URL does not match its number');
  const marker = validateRolloutLedgerMarker(uploadAttempt.marker.title, uploadAttempt.marker.body);
  invariant(marker.type === 'uploadAttempt', 'Recovery proof ledger schema is not upload-attempt/v1');
  const attemptPayload = marker.payload;
  invariant(attemptPayload.runId === SKIPPED_UPLOAD_RECOVERY_CONTRACT.runId,
    'Upload attempt workflow run ID has no reviewed skipped-upload recovery contract');
  invariant(attemptPayload.runAttempt === 1,
    'Skipped-upload recovery recognizes only original workflow run attempt 1');
  invariant(attemptPayload.workflowSha === SKIPPED_UPLOAD_RECOVERY_CONTRACT.workflowSha,
    'Upload attempt workflow SHA has no reviewed skipped-upload recovery contract');
  const apiRoot = `https://api.github.com/repos/${EXPECTED_REPOSITORY}`;
  const runUrl = `${apiRoot}/actions/runs/${attemptPayload.runId}`;
  const latestRun = await githubIssueJson(fetchImpl, runUrl, token, 'Latest prior workflow run', {
    requestTimeoutMs,
  });
  invariant(isRecord(latestRun), 'Latest prior workflow run response is invalid');
  const latestAttempt = validatePositiveId(latestRun.run_attempt, 'Latest prior workflow run attempt');
  invariant(latestAttempt === attemptPayload.runAttempt,
    'A later rerun of the original upload workflow exists; recovery is forbidden');
  const latestEvidence = validateRecoveryRunResponse(latestRun, attemptPayload, 'Latest prior workflow run');
  const exactRun = await githubIssueJson(fetchImpl,
    `${runUrl}/attempts/${attemptPayload.runAttempt}`, token, 'Exact prior workflow run attempt', {
      requestTimeoutMs,
    });
  const runEvidence = validateRecoveryRunResponse(exactRun, attemptPayload, 'Exact prior workflow run attempt');
  invariant(stableJson(latestEvidence) === stableJson(runEvidence),
    'Latest and exact prior workflow run evidence do not match');
  const { jobs, totalCount } = await listRecoveryRunJobs({
    apiRoot,
    runId: attemptPayload.runId,
    runAttempt: attemptPayload.runAttempt,
    token,
    fetchImpl,
    requestTimeoutMs,
  });
  const uploadJobs = jobs.filter((job) => job.name === SKIPPED_UPLOAD_RECOVERY_CONTRACT.jobName);
  invariant(uploadJobs.length === 1,
    'Prior run must contain exactly one pinned protected upload job');
  const listedJob = uploadJobs[0];
  const criticalSteps = validateRecoveryJobSteps(listedJob);
  const directJob = await githubIssueJson(fetchImpl, listedJob.url, token, 'Direct prior upload job', {
    requestTimeoutMs,
  });
  invariant(stableJson(directJob) === stableJson(listedJob),
    'Direct prior upload job response does not exactly match the paginated job list');
  validateListedJob(directJob, attemptPayload.runId, attemptPayload.runAttempt, new Set());
  validateRecoveryJobSteps(directJob);
  return canonicalRecoveryEvidence({
    run: runEvidence,
    job: {
      jobsTotalCount: totalCount,
      jobId: listedJob.id,
      apiUrl: listedJob.url,
      jobUrl: listedJob.html_url,
      jobName: listedJob.name,
      status: listedJob.status,
      conclusion: listedJob.conclusion,
      headSha: listedJob.head_sha,
      runId: listedJob.run_id,
      runAttempt: listedJob.run_attempt,
      steps: criticalSteps,
    },
  });
}

function validateLedgerDelaySchedule(delays, confirmationDelayMs) {
  invariant(Array.isArray(delays) && delays.length > 0 && delays.length <= 32,
    'Ledger visibility delay schedule must contain 1 through 32 entries');
  invariant(delays.every((delay) => Number.isFinite(delay) && delay >= 0),
    'Ledger visibility delays must be nonnegative finite milliseconds');
  invariant(Number.isFinite(confirmationDelayMs) && confirmationDelayMs >= 0,
    'Ledger confirmation delay must be nonnegative finite milliseconds');
}

async function waitForStableRolloutLedger({
  identity,
  token,
  fetchImpl,
  requestTimeoutMs,
  sleep,
  visibilityDelaysMs,
  confirmationDelayMs,
  matches,
  label,
}) {
  invariant(typeof sleep === 'function', 'Ledger visibility sleeper must be a function');
  invariant(typeof matches === 'function', 'Ledger visibility matcher must be a function');
  validateLedgerDelaySchedule(visibilityDelaysMs, confirmationDelayMs);
  for (const delay of visibilityDelaysMs) {
    await sleep(delay);
    const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
    if (!matches(scan.records)) continue;
    await sleep(confirmationDelayMs);
    const confirmation = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
    if (matches(confirmation.records)) return confirmation;
  }
  throw new Error(`${label} never became visible and stable in the bounded repository scans`);
}

async function createRolloutLedger({ scan, type, input, token, fetchImpl, requestTimeoutMs }) {
  const marker = formatRolloutLedgerMarker(type, input);
  const created = await githubIssueJson(fetchImpl, `${scan.apiRoot}/issues`, token,
    `${type} ledger issue creation`, {
      method: 'POST', body: { title: marker.title, body: marker.body }, requestTimeoutMs,
    });
  const creation = validateRolloutIssue(created, scan.expected.repository, marker, `Created ${type} ledger`, true);
  const fetched = await githubIssueJson(fetchImpl, `${scan.apiRoot}/issues/${creation.number}`, token,
    `${type} ledger issue verification`, { requestTimeoutMs });
  return validateRolloutIssue(fetched, scan.expected.repository, marker, `Verified ${type} ledger`);
}

export async function claimUploadAttempt({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  visibilityDelaysMs = LEDGER_VISIBILITY_DELAYS_MS,
  confirmationDelayMs = LEDGER_CONFIRMATION_DELAY_MS,
  ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 0,
    'An upload attempt ledger already exists; an automated upload retry is forbidden');
  invariant(scan.records.uploadSuccess.length === 0
    && scan.records.uploadResumeAttempt.length === 0
    && scan.records.recoveryUploadSuccess.length === 0
    && scan.records.submitAttempt.length === 0,
    'Later staged rollout ledgers exist without an upload attempt');
  const issue = await createRolloutLedger({ scan, type: 'uploadAttempt', input: identity,
    token, fetchImpl, requestTimeoutMs });
  await waitForStableRolloutLedger({
    identity, token, fetchImpl, requestTimeoutMs, sleep, visibilityDelaysMs, confirmationDelayMs,
    label: 'Created upload-attempt ledger',
    matches: (records) => records.uploadAttempt.length === 1
      && records.uploadAttempt[0].number === issue.number
      && records.uploadSuccess.length === 0
      && records.uploadResumeAttempt.length === 0
      && records.recoveryUploadSuccess.length === 0
      && records.submitAttempt.length === 0,
  });
  return { issueNumber: issue.number, issueUrl: issue.issueUrl, marker: issue.marker };
}

export async function recordUploadSuccess({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  visibilityDelaysMs = LEDGER_VISIBILITY_DELAYS_MS,
  confirmationDelayMs = LEDGER_CONFIRMATION_DELAY_MS,
  ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 1, 'Exactly one upload attempt ledger is required');
  invariant(scan.records.uploadResumeAttempt.length === 0,
    'A normal upload success cannot follow an upload resume ledger');
  invariant(scan.records.uploadSuccess.length === 0 && scan.records.recoveryUploadSuccess.length === 0,
    'An upload success ledger already exists');
  invariant(scan.records.submitAttempt.length === 0, 'A submit attempt cannot predate upload success');
  const attempt = scan.records.uploadAttempt[0];
  const currentRun = rolloutRunIdentity({ repository: scan.expected.repository, ...identity });
  assertSameRolloutRun(currentRun, attempt.marker.payload,
    'Normal upload success run identity');
  const issue = await createRolloutLedger({ scan, type: 'uploadSuccess', input: {
    ...identity,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
  }, token, fetchImpl, requestTimeoutMs });
  await waitForStableRolloutLedger({
    identity, token, fetchImpl, requestTimeoutMs, sleep, visibilityDelaysMs, confirmationDelayMs,
    label: 'Created upload-success ledger',
    matches: (records) => records.uploadAttempt.length === 1
      && records.uploadAttempt[0].number === attempt.number
      && records.uploadSuccess.length === 1
      && records.uploadSuccess[0].number === issue.number
      && records.uploadResumeAttempt.length === 0
      && records.recoveryUploadSuccess.length === 0
      && records.submitAttempt.length === 0,
  });
  return { issueNumber: issue.number, issueUrl: issue.issueUrl, marker: issue.marker,
    uploadAttemptIssueNumber: attempt.number, uploadAttemptIssueUrl: attempt.issueUrl };
}

export async function claimUploadResumeAttempt({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  visibilityDelaysMs = LEDGER_VISIBILITY_DELAYS_MS,
  confirmationDelayMs = LEDGER_CONFIRMATION_DELAY_MS,
  ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 1,
    'Exactly one canonical original upload-attempt/v1 ledger is required for recovery');
  invariant(scan.records.uploadResumeAttempt.length === 0,
    'An upload resume ledger already exists; skipped-upload recovery is one-shot');
  invariant(scan.records.uploadSuccess.length === 0 && scan.records.recoveryUploadSuccess.length === 0,
    'Skipped-upload recovery requires no upload-success ledger');
  invariant(scan.records.submitAttempt.length === 0,
    'Skipped-upload recovery requires no submit-attempt ledger');
  const attempt = scan.records.uploadAttempt[0];
  assertOpenPinnedRecoveryAttempt(attempt);
  const currentRun = rolloutRunIdentity({ repository: scan.expected.repository, ...identity });
  invariant(currentRun.runAttempt === 1, 'Skipped-upload recovery is restricted to workflow run attempt 1');
  invariant(currentRun.runId !== attempt.marker.payload.runId,
    'Skipped-upload recovery must use a separate workflow run');
  const priorEvidence = await verifySkippedUploadRecoveryEvidence({
    uploadAttempt: attempt, token, fetchImpl, requestTimeoutMs,
  });
  const issue = await createRolloutLedger({ scan, type: 'uploadResumeAttempt', input: {
    ...identity,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    priorEvidence,
  }, token, fetchImpl, requestTimeoutMs });
  await waitForStableRolloutLedger({
    identity, token, fetchImpl, requestTimeoutMs, sleep, visibilityDelaysMs, confirmationDelayMs,
    label: 'Created upload-resume-attempt ledger',
    matches: (records) => records.uploadAttempt.length === 1
      && records.uploadAttempt[0].number === attempt.number
      && records.uploadAttempt[0].state === 'open'
      && records.uploadResumeAttempt.length === 1
      && records.uploadResumeAttempt[0].number === issue.number
      && records.uploadSuccess.length === 0
      && records.recoveryUploadSuccess.length === 0
      && records.submitAttempt.length === 0,
  });
  return {
    issueNumber: issue.number,
    issueUrl: issue.issueUrl,
    marker: issue.marker,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    priorEvidence,
  };
}

export async function recordRecoveryUploadSuccess({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  visibilityDelaysMs = LEDGER_VISIBILITY_DELAYS_MS,
  confirmationDelayMs = LEDGER_CONFIRMATION_DELAY_MS,
  ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 1,
    'Exactly one canonical original upload-attempt/v1 ledger is required');
  invariant(scan.records.uploadResumeAttempt.length === 1,
    'Exactly one canonical upload-resume-attempt/v1 ledger is required');
  invariant(scan.records.uploadSuccess.length === 0 && scan.records.recoveryUploadSuccess.length === 0,
    'An upload success ledger already exists');
  invariant(scan.records.submitAttempt.length === 0, 'A submit attempt cannot predate recovery upload success');
  const attempt = scan.records.uploadAttempt[0];
  const resume = scan.records.uploadResumeAttempt[0];
  assertOpenPinnedRecoveryAttempt(attempt);
  const currentRun = rolloutRunIdentity({ repository: scan.expected.repository, ...identity });
  assertSameRolloutRun(currentRun, resume.marker.payload,
    'Recovery upload success run identity');
  const issue = await createRolloutLedger({ scan, type: 'recoveryUploadSuccess', input: {
    ...identity,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    uploadResumeIssueNumber: resume.number,
    uploadResumeIssueUrl: resume.issueUrl,
  }, token, fetchImpl, requestTimeoutMs });
  await waitForStableRolloutLedger({
    identity, token, fetchImpl, requestTimeoutMs, sleep, visibilityDelaysMs, confirmationDelayMs,
    label: 'Created recovery upload-success/v2 ledger',
    matches: (records) => records.uploadAttempt.length === 1
      && records.uploadAttempt[0].number === attempt.number
      && records.uploadAttempt[0].state === 'open'
      && records.uploadResumeAttempt.length === 1
      && records.uploadResumeAttempt[0].number === resume.number
      && records.uploadSuccess.length === 0
      && records.recoveryUploadSuccess.length === 1
      && records.recoveryUploadSuccess[0].number === issue.number
      && records.submitAttempt.length === 0,
  });
  return {
    issueNumber: issue.number,
    issueUrl: issue.issueUrl,
    marker: issue.marker,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    uploadResumeIssueNumber: resume.number,
    uploadResumeIssueUrl: resume.issueUrl,
  };
}

export async function verifyUploadLedgers({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 1, 'Exactly one canonical upload attempt ledger is required');
  const successes = [...scan.records.uploadSuccess, ...scan.records.recoveryUploadSuccess];
  invariant(successes.length === 1, 'Exactly one canonical linked upload success ledger is required');
  const attempt = scan.records.uploadAttempt[0];
  const resume = scan.records.uploadResumeAttempt[0];
  if (resume !== undefined) assertOpenPinnedRecoveryAttempt(attempt);
  const success = successes[0];
  const submit = scan.records.submitAttempt[0];
  return {
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    uploadSuccessIssueNumber: success.number,
    uploadSuccessIssueUrl: success.issueUrl,
    recoveryChain: resume !== undefined,
    uploadResumeIssueNumber: resume?.number,
    uploadResumeIssueUrl: resume?.issueUrl,
    submitAttemptExists: submit !== undefined,
    submitAttemptIssueNumber: submit?.number,
    submitAttemptIssueUrl: submit?.issueUrl,
  };
}

export async function claimSubmitAttempt({ token, fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  visibilityDelaysMs = LEDGER_VISIBILITY_DELAYS_MS,
  confirmationDelayMs = LEDGER_CONFIRMATION_DELAY_MS,
  ...identity }) {
  const scan = await scanRolloutLedgers({ identity, token, fetchImpl, requestTimeoutMs });
  invariant(scan.records.uploadAttempt.length === 1, 'Exactly one canonical upload attempt ledger is required');
  const successes = [...scan.records.uploadSuccess, ...scan.records.recoveryUploadSuccess];
  invariant(successes.length === 1, 'Exactly one canonical linked upload success ledger is required');
  invariant(scan.records.submitAttempt.length === 0,
    'A submit attempt ledger already exists; inspect exact store status and do not retry');
  const attempt = scan.records.uploadAttempt[0];
  const resume = scan.records.uploadResumeAttempt[0];
  if (resume !== undefined) assertOpenPinnedRecoveryAttempt(attempt);
  const success = successes[0];
  const issue = await createRolloutLedger({ scan, type: 'submitAttempt', input: {
    ...identity,
    uploadAttemptIssueNumber: attempt.number,
    uploadAttemptIssueUrl: attempt.issueUrl,
    uploadSuccessIssueNumber: success.number,
    uploadSuccessIssueUrl: success.issueUrl,
  }, token, fetchImpl, requestTimeoutMs });
  await waitForStableRolloutLedger({
    identity, token, fetchImpl, requestTimeoutMs, sleep, visibilityDelaysMs, confirmationDelayMs,
    label: 'Created submit-attempt ledger',
    matches: (records) => records.uploadAttempt.length === 1
      && records.uploadAttempt[0].number === attempt.number
      && (records.uploadResumeAttempt.length === 0
        || records.uploadAttempt[0].state === 'open')
      && records.uploadSuccess.length + records.recoveryUploadSuccess.length === 1
      && (records.uploadSuccess[0] ?? records.recoveryUploadSuccess[0]).number === success.number
      && records.submitAttempt.length === 1
      && records.submitAttempt[0].number === issue.number,
  });
  return { issueNumber: issue.number, issueUrl: issue.issueUrl, marker: issue.marker };
}

export function validateReleaseEvent(tag, eventReleaseId) {
  parseReleaseTag(tag);
  invariant(tag !== 'v0.3.0',
    'The legacy v0.3.0 release event is excluded; use the manual staged rollout with exact confirmations');
  return parsePositiveId(eventReleaseId, 'Event release ID');
}

async function resolveAnnotatedTag(fetchImpl, repository, token, tag) {
  const encodedTag = encodeURIComponent(tag);
  const reference = await githubJson(fetchImpl,
    `https://api.github.com/repos/${repository}/git/ref/tags/${encodedTag}`, token, 'Git tag lookup');
  invariant(isRecord(reference?.object), 'Git tag reference response is invalid');
  invariant(reference.object.type === 'tag', 'Release tags must be annotated, not lightweight');
  const tagObject = validateSha(reference.object.sha, 'Annotated tag object');
  let object = await githubJson(fetchImpl,
    `https://api.github.com/repos/${repository}/git/tags/${tagObject}`, token, 'Annotated tag lookup');
  invariant(object.tag === tag, 'Annotated tag names a different release tag');
  invariant(isRecord(object.object), 'Annotated tag target is invalid');
  const seen = new Set([tagObject]);
  while (object.object.type === 'tag') {
    const nestedSha = validateSha(object.object.sha, 'Nested tag object');
    invariant(!seen.has(nestedSha), 'Annotated tag cycle detected');
    seen.add(nestedSha);
    object = await githubJson(fetchImpl,
      `https://api.github.com/repos/${repository}/git/tags/${nestedSha}`, token, 'Nested tag lookup');
    invariant(isRecord(object.object), 'Nested tag target is invalid');
  }
  invariant(object.object.type === 'commit', `Annotated tag resolves to unexpected ${String(object.object.type)} object`);
  return { tagObject, commit: validateSha(object.object.sha, 'Release commit') };
}

function decodeGitHubContent(response, label) {
  invariant(isRecord(response) && response.type === 'file' && response.encoding === 'base64' && typeof response.content === 'string',
    `${label} response is invalid`);
  const compact = response.content.replace(/\s/g, '');
  invariant(/^[A-Za-z0-9+/]*={0,2}$/.test(compact), `${label} has invalid Base64 content`);
  return Buffer.from(compact, 'base64');
}

export async function resolveGitHubRelease({
  repository = EXPECTED_REPOSITORY,
  tag,
  token,
  artifactPath,
  fetchImpl = fetch,
  eventReleaseId,
  expected = {},
}) {
  validateRepositoryName(repository);
  parseReleaseTag(tag);
  invariant(typeof artifactPath === 'string' && artifactPath.length > 0 && !artifactPath.includes('\0'),
    'Artifact path is required');
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const [repositoryRecord, release, resolvedTag] = await Promise.all([
    githubJson(fetchImpl, apiRoot, token, 'Repository lookup'),
    githubJson(fetchImpl, `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`, token, 'Release lookup'),
    resolveAnnotatedTag(fetchImpl, repository, token, tag),
  ]);
  const metadata = validateReleaseRecord({ repository, repositoryRecord, release, tag, ...resolvedTag });
  if (eventReleaseId !== undefined) {
    invariant(metadata.releaseId === validateReleaseEvent(tag, eventReleaseId),
      'Release event ID does not match the resolved release');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key !== 'sha256' && value !== undefined) {
      invariant(String(metadata[key]) === String(value), `Validated ${key} changed after approval`);
    }
  }

  const packageResponse = await githubJson(fetchImpl,
    `${apiRoot}/contents/package.json?ref=${encodeURIComponent(metadata.commit)}`, token, 'Release package.json lookup');
  let packageDocument;
  try {
    packageDocument = JSON.parse(decodeGitHubContent(packageResponse, 'package.json').toString('utf8'));
  } catch (error) {
    throw new Error(`Release package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(isRecord(packageDocument) && packageDocument.name === 'eipeek', 'Release package name must be eipeek');
  invariant(packageDocument.version === metadata.version, 'Release package version does not match its tag');

  const bytes = await boundedRequest(fetchImpl, `${apiRoot}/releases/assets/${metadata.assetId}`, {
    headers: githubHeaders(token, 'application/octet-stream'),
    redirect: 'follow',
  }, 'Release asset download', async (assetResponse) => {
    if (!assetResponse.ok) throw await responseError(assetResponse, 'Release asset download');
    return Buffer.from(await assetResponse.arrayBuffer());
  });
  invariant(bytes.length === metadata.assetSize, 'Downloaded release asset size does not match GitHub metadata');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (metadata.apiSha256 !== undefined) invariant(sha256 === metadata.apiSha256, 'Downloaded asset does not match GitHub digest');
  if (metadata.pinnedSha256 !== undefined) invariant(sha256 === metadata.pinnedSha256, 'Legacy release asset does not match pinned digest');
  if (expected.sha256 !== undefined) invariant(sha256 === validateSha256(String(expected.sha256)), 'Validated sha256 changed after approval');
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const manifest = await readAndValidateZipManifest(artifactPath, metadata.version);
  return { ...metadata, sha256, manifest };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizedFileName(name, label = 'ZIP entry') {
  invariant(typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.startsWith('/')
    && !/^[A-Za-z]:/.test(name) && !name.endsWith('/') && !/[\0-\x1f\x7f]/.test(name),
  `Unsafe ${label}: ${String(name)}`);
  const parts = name.split('/');
  invariant(parts.every((part) => part.length > 0 && part !== '..' && part !== '.'),
    `Unsafe ${label}: ${name}`);
  return parts.map((part) => part.normalize('NFC')).join('/');
}

function decodeZipName(bytes, utf8) {
  if (!utf8) invariant(bytes.every((byte) => byte >= 0x20 && byte <= 0x7e),
    'ZIP entry names without the UTF-8 flag must be ASCII');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('ZIP entry name is not valid UTF-8');
  }
}

function findEndOfCentralDirectory(zipBytes) {
  const minimum = Math.max(0, zipBytes.length - 65_557);
  for (let offset = zipBytes.length - 22; offset >= minimum; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === EOCD_SIGNATURE
      && offset + 22 + zipBytes.readUInt16LE(offset + 20) === zipBytes.length) return offset;
  }
  throw new Error('Release ZIP has no valid end-of-central-directory record');
}

function entryIsDetectablyRegular(versionMadeBy, externalAttributes, name) {
  const host = versionMadeBy >>> 8;
  if (host === 3 || host === 19) {
    const mode = externalAttributes >>> 16;
    const type = mode & 0o170000;
    invariant(type === 0 || type === 0o100000, `ZIP entry is not a regular file: ${name}`);
  }
  invariant((externalAttributes & 0x10) === 0, `ZIP entry is not a regular file: ${name}`);
}

export function parseZipFiles(zipBytes) {
  invariant(Buffer.isBuffer(zipBytes) && zipBytes.length >= 22, 'Release ZIP bytes are invalid');
  const eocd = findEndOfCentralDirectory(zipBytes);
  invariant(zipBytes.readUInt16LE(eocd + 20) === 0, 'Release ZIP archive comments are not supported');
  const disk = zipBytes.readUInt16LE(eocd + 4);
  const centralDisk = zipBytes.readUInt16LE(eocd + 6);
  const diskEntries = zipBytes.readUInt16LE(eocd + 8);
  const entryCount = zipBytes.readUInt16LE(eocd + 10);
  const centralSize = zipBytes.readUInt32LE(eocd + 12);
  const centralOffset = zipBytes.readUInt32LE(eocd + 16);
  invariant(disk === 0 && centralDisk === 0 && diskEntries === entryCount, 'Multi-disk ZIP archives are not supported');
  invariant(entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff,
    'ZIP64 release archives are not supported');
  invariant(entryCount > 0, 'Release ZIP is empty');
  invariant(centralOffset + centralSize === eocd, 'Release ZIP central directory bounds are invalid');

  const files = new Map();
  const dataRanges = [];
  let totalSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    invariant(offset + 46 <= eocd && zipBytes.readUInt32LE(offset) === CENTRAL_SIGNATURE,
      'Release ZIP central directory is malformed');
    const versionMadeBy = zipBytes.readUInt16LE(offset + 4);
    const flags = zipBytes.readUInt16LE(offset + 8);
    const method = zipBytes.readUInt16LE(offset + 10);
    const expectedCrc = zipBytes.readUInt32LE(offset + 16);
    const compressedSize = zipBytes.readUInt32LE(offset + 20);
    const uncompressedSize = zipBytes.readUInt32LE(offset + 24);
    const nameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const startingDisk = zipBytes.readUInt16LE(offset + 34);
    const externalAttributes = zipBytes.readUInt32LE(offset + 38);
    const localOffset = zipBytes.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    invariant(nextOffset <= eocd, 'Release ZIP central directory entry exceeds its bounds');
    invariant(startingDisk === 0, 'Multi-disk ZIP entries are not supported');
    invariant(extraLength === 0, 'Release ZIP central extra fields are not supported');
    invariant(commentLength === 0, 'Release ZIP entry comments are not supported');
    invariant((flags & ~0x0800) === 0, 'Encrypted or specially encoded ZIP entries are not supported');
    invariant(method === 0 || method === 8, `Unsupported ZIP compression method ${method}`);
    invariant(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && localOffset !== 0xffffffff,
      'ZIP64 entries are not supported');
    invariant(uncompressedSize <= MAX_ZIP_ENTRY_BYTES, 'Release ZIP entry exceeds the size limit');
    totalSize += uncompressedSize;
    invariant(totalSize <= MAX_ZIP_TOTAL_BYTES, 'Release ZIP contents exceed the total size limit');
    const centralNameBytes = zipBytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeZipName(centralNameBytes, (flags & 0x0800) !== 0);
    const name = normalizedFileName(rawName);
    invariant(!files.has(name), `Release ZIP contains duplicate normalized entry ${name}`);
    entryIsDetectablyRegular(versionMadeBy, externalAttributes, name);

    invariant(localOffset + 30 <= centralOffset && zipBytes.readUInt32LE(localOffset) === LOCAL_SIGNATURE,
      `ZIP local header is invalid for ${name}`);
    const localFlags = zipBytes.readUInt16LE(localOffset + 6);
    const localMethod = zipBytes.readUInt16LE(localOffset + 8);
    const localCrc = zipBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = zipBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = zipBytes.readUInt32LE(localOffset + 22);
    const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    invariant(localExtraLength === 0, `ZIP local extra fields are not supported for ${name}`);
    invariant(localFlags === flags && localMethod === method && localCrc === expectedCrc
      && localCompressedSize === compressedSize && localUncompressedSize === uncompressedSize
      && dataEnd <= centralOffset,
      `ZIP local entry bounds are invalid for ${name}`);
    const localName = decodeZipName(zipBytes.subarray(localNameStart, localNameStart + localNameLength),
      (flags & 0x0800) !== 0);
    invariant(localName === rawName, `ZIP local and central names differ for ${name}`);
    invariant(!dataRanges.some(([start, end]) => localOffset < end && dataEnd > start),
      `ZIP entries overlap at ${name}`);
    dataRanges.push([localOffset, dataEnd]);

    const compressed = zipBytes.subarray(dataStart, dataEnd);
    let contents;
    try {
      contents = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch (error) {
      throw new Error(`Unable to decompress ZIP entry ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    invariant(contents.length === uncompressedSize, `ZIP entry size is invalid for ${name}`);
    invariant(crc32(contents) === expectedCrc, `ZIP entry checksum is invalid for ${name}`);
    files.set(name, contents);
    offset = nextOffset;
  }
  invariant(offset === eocd, 'Release ZIP central directory has unparsed data');
  dataRanges.sort(([left], [right]) => left - right);
  invariant(dataRanges[0][0] === 0
    && dataRanges.every((range, index) => index === 0 || dataRanges[index - 1][1] === range[0])
    && dataRanges.at(-1)[1] === centralOffset,
  'Release ZIP contains unindexed or interleaved local data');
  return files;
}

async function readDirectoryFiles(rootDirectory) {
  const root = resolve(rootDirectory);
  invariant((await lstat(root)).isDirectory(), 'Built extension path must be a directory');
  const files = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      invariant(fullPath === root || fullPath.startsWith(`${root}${sep}`), 'Built extension path escaped its root');
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      invariant(entry.isFile(), `Built extension contains a non-regular entry: ${entry.name}`);
      const name = normalizedFileName(relative(root, fullPath).split(sep).join('/'), 'built extension path');
      invariant(!files.has(name), `Built extension contains duplicate normalized path ${name}`);
      files.set(name, await readFile(fullPath));
    }
  }
  await visit(root);
  invariant(files.size > 0, 'Built extension directory is empty');
  return files;
}

export async function compareZipToDirectory(zipPath, directoryPath) {
  const archiveFiles = parseZipFiles(await readFile(zipPath));
  const builtFiles = await readDirectoryFiles(directoryPath);
  const archiveNames = [...archiveFiles.keys()].sort();
  const builtNames = [...builtFiles.keys()].sort();
  const missing = builtNames.filter((name) => !archiveFiles.has(name));
  const extra = archiveNames.filter((name) => !builtFiles.has(name));
  invariant(missing.length === 0 && extra.length === 0,
    `Release ZIP tree differs from tagged build (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  const different = builtNames.filter((name) => !archiveFiles.get(name).equals(builtFiles.get(name)));
  invariant(different.length === 0, `Release ZIP file bytes differ from tagged build: ${different.join(', ')}`);
  return { fileCount: builtFiles.size };
}

export function validateManifest(manifest, expectedVersion) {
  parseChromeVersion(expectedVersion, 3);
  invariant(isRecord(manifest), 'ZIP manifest must be a JSON object');
  invariant(manifest.manifest_version === 3, 'Release artifact must use manifest version 3');
  invariant(manifest.name === 'EIPeek', 'Release artifact name must be EIPeek');
  invariant(manifest.version === expectedVersion, 'Manifest version does not match the release tag');
  invariant(Array.isArray(manifest.permissions) && JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'alarms']),
    'Manifest permissions must be exactly storage and alarms');
  for (const field of ['host_permissions', 'optional_permissions', 'optional_host_permissions',
    'externally_connectable', 'web_accessible_resources']) {
    invariant(!Object.hasOwn(manifest, field), `Manifest must not declare ${field}`);
  }
  invariant(!manifest.permissions.includes('tabs'), 'Manifest must not request tabs');
  return manifest;
}

export async function readAndValidateZipManifest(zipPath, expectedVersion) {
  invariant(typeof zipPath === 'string' && zipPath.length > 0 && !zipPath.includes('\0'), 'ZIP path is invalid');
  const files = parseZipFiles(await readFile(zipPath));
  invariant(files.has('manifest.json'), 'Release ZIP must contain exactly one root manifest.json');
  const manifestBytes = files.get('manifest.json');
  invariant(manifestBytes.length <= MAX_MANIFEST_BYTES, 'Release manifest exceeds the size limit');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(manifest, expectedVersion);
}

export function validatePublisherId(publisherId) {
  invariant(typeof publisherId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(publisherId),
  'Chrome Web Store publisher ID must be a nonempty RFC 4122 version 4 UUID resource path component');
}

function validateExtensionId(extensionId) {
  invariant(typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId), 'Chrome extension ID is invalid');
  invariant(extensionId === EXPECTED_EXTENSION_ID, 'Configured Chrome extension ID does not match EIPeek');
}

export function deriveExtensionId(publicKey) {
  invariant(typeof publicKey === 'string' && publicKey.length > 0, 'Chrome Web Store status omitted publicKey');
  const base64 = publicKey
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');
  invariant(base64.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), 'Chrome Web Store publicKey is invalid Base64');
  const keyBytes = Buffer.from(base64, 'base64');
  invariant(keyBytes.length > 0, 'Chrome Web Store publicKey decoded to empty bytes');
  const canonical = keyBytes.toString('base64').replace(/=+$/, '');
  invariant(canonical === base64.replace(/=+$/, ''), 'Chrome Web Store publicKey is not canonical Base64');
  const hex = createHash('sha256').update(keyBytes).digest('hex').slice(0, 32);
  return [...hex].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join('');
}

export function verifyItemIdentity(response, publisherId, extensionId, label) {
  invariant(isRecord(response), `${label} response must be an object`);
  invariant(response.itemId === extensionId, `${label} response item ID does not match`);
  invariant(response.name === `publishers/${publisherId}/items/${extensionId}`, `${label} response item name does not match`);
  return response;
}

function revisionVersion(revision, label) {
  if (revision === undefined) return undefined;
  invariant(isRecord(revision), `${label} revision is invalid`);
  invariant(ITEM_STATES.has(revision.state), `${label} revision has unexpected state ${String(revision.state)}`);
  invariant(Array.isArray(revision.distributionChannels) && revision.distributionChannels.length > 0,
    `${label} revision has no distribution channel`);
  const versions = new Set(revision.distributionChannels.map((channel) => {
    invariant(isRecord(channel), `${label} distribution channel is invalid`);
    parseChromeVersion(channel.crxVersion);
    return channel.crxVersion;
  }));
  invariant(versions.size === 1, `${label} revision reports conflicting package versions`);
  return [...versions][0];
}

export function decidePublishAction(status, requestedVersion) {
  parseChromeVersion(requestedVersion, 3);
  invariant(isRecord(status), 'Chrome Web Store status is invalid');
  invariant(status.takenDown !== true, 'Chrome Web Store item is taken down; resolve policy enforcement manually');
  invariant(status.warned !== true, 'Chrome Web Store item has an unresolved policy warning');
  if (status.lastAsyncUploadState !== undefined) {
    invariant(UPLOAD_STATES.has(status.lastAsyncUploadState),
      `Unexpected upload state ${String(status.lastAsyncUploadState)}`);
    invariant(status.lastAsyncUploadState !== 'IN_PROGRESS', 'Another Chrome Web Store upload is in progress');
    invariant(status.lastAsyncUploadState !== 'FAILED',
      'A failed Chrome Web Store upload has an ambiguous draft state; resolve it manually');
  }

  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus, 'Published');
  const submittedVersion = revisionVersion(status.submittedItemRevisionStatus, 'Submitted');
  const submittedState = status.submittedItemRevisionStatus?.state;
  if (status.publishedItemRevisionStatus !== undefined) {
    invariant(status.publishedItemRevisionStatus.state === 'PUBLISHED',
      `Published revision has unexpected state ${String(status.publishedItemRevisionStatus.state)}`);
  }

  if (submittedState === 'PENDING_REVIEW') {
    invariant(submittedVersion === requestedVersion,
      `A conflicting ${submittedState} submission for version ${submittedVersion} already exists`);
    return { action: 'noop', reason: submittedState.toLowerCase(), version: requestedVersion };
  }
  invariant(submittedState !== 'STAGED',
    `A staged submission for version ${submittedVersion} requires manual resolution`);
  invariant(submittedState !== 'PUBLISHED_TO_TESTERS',
    `A testers-only submission for version ${submittedVersion} requires manual resolution`);
  if (submittedState === 'PUBLISHED') {
    invariant(submittedVersion === requestedVersion,
      `Store status reports an unexpected published submission for version ${submittedVersion}`);
    return { action: 'noop', reason: 'published', version: requestedVersion };
  }
  if (publishedVersion !== undefined) {
    const comparison = compareChromeVersions(requestedVersion, publishedVersion);
    invariant(comparison >= 0, `Refusing downgrade from ${publishedVersion} to ${requestedVersion}`);
    if (comparison === 0) return { action: 'noop', reason: 'already-published', version: requestedVersion };
  }
  if (submittedState === 'REJECTED' || submittedState === 'CANCELLED') {
    invariant(compareChromeVersions(requestedVersion, submittedVersion) > 0,
      `Refusing version ${requestedVersion} after ${submittedState} submission ${submittedVersion}; create a newer release`);
  }
  if (status.lastAsyncUploadState === 'SUCCEEDED') {
    throw new Error('A recent successful upload has ambiguous submission state; do not retry automatically; '
      + 'resolve it manually in the Developer Dashboard');
  }
  return { action: 'upload', reason: 'new-version', version: requestedVersion };
}

export const decideUploadAction = decidePublishAction;

export function decideSubmitAction(status, requestedVersion, {
  uploadLedgersVerified = false,
  submitAttemptExists = false,
} = {}) {
  invariant(uploadLedgersVerified === true,
    'Exact linked upload attempt and synchronous-success ledgers must be verified before submission');
  parseChromeVersion(requestedVersion, 3);
  invariant(isRecord(status), 'Chrome Web Store status is invalid');
  invariant(status.takenDown !== true, 'Chrome Web Store item is taken down; resolve policy enforcement manually');
  invariant(status.warned !== true, 'Chrome Web Store item has an unresolved policy warning');
  if (status.lastAsyncUploadState !== undefined) {
    invariant(UPLOAD_STATES.has(status.lastAsyncUploadState),
      `Unexpected upload state ${String(status.lastAsyncUploadState)}`);
    invariant(status.lastAsyncUploadState !== 'IN_PROGRESS', 'Another Chrome Web Store upload is in progress');
    invariant(status.lastAsyncUploadState !== 'FAILED',
      'A failed Chrome Web Store upload has an ambiguous draft state; resolve it manually');
  }

  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus, 'Published');
  const submittedVersion = revisionVersion(status.submittedItemRevisionStatus, 'Submitted');
  const submittedState = status.submittedItemRevisionStatus?.state;
  if (status.publishedItemRevisionStatus !== undefined) {
    invariant(status.publishedItemRevisionStatus.state === 'PUBLISHED',
      `Published revision has unexpected state ${String(status.publishedItemRevisionStatus.state)}`);
  }
  if (submittedState === 'PENDING_REVIEW') {
    invariant(submittedVersion === requestedVersion,
      `A conflicting ${submittedState} submission for version ${submittedVersion} already exists`);
    return { action: 'noop', reason: 'pending_review', version: requestedVersion };
  }
  invariant(submittedState !== 'STAGED',
    `A staged submission for version ${submittedVersion} requires manual resolution`);
  invariant(submittedState !== 'PUBLISHED_TO_TESTERS',
    `A testers-only submission for version ${submittedVersion} requires manual resolution`);
  if (submittedState === 'PUBLISHED') {
    invariant(submittedVersion === requestedVersion,
      `Store status reports an unexpected published submission for version ${submittedVersion}`);
    return { action: 'noop', reason: 'published', version: requestedVersion };
  }
  if (publishedVersion !== undefined) {
    const comparison = compareChromeVersions(requestedVersion, publishedVersion);
    invariant(comparison >= 0, `Refusing downgrade from ${publishedVersion} to ${requestedVersion}`);
    if (comparison === 0) return { action: 'noop', reason: 'already-published', version: requestedVersion };
  }
  if (submittedState === 'REJECTED' || submittedState === 'CANCELLED') {
    invariant(compareChromeVersions(requestedVersion, submittedVersion) > 0,
      `Refusing version ${requestedVersion} after ${submittedState} submission ${submittedVersion}; create a newer release`);
  }
  invariant(!submitAttemptExists,
    'A submit attempt ledger exists without an exact pending or published store state; resolve manually');
  return { action: 'submit', reason: 'verified-synchronous-upload', version: requestedVersion };
}

function cwsHeaders(accessToken, extra = {}) {
  invariant(typeof accessToken === 'string' && accessToken.length > 0, 'CWS access token is required');
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

async function cwsJson(fetchImpl, url, options, label, requestTimeoutMs) {
  try {
    return await boundedRequest(fetchImpl, url, options, label, async (response) => {
      if (!response.ok) throw await responseError(response, label);
      try {
        return await response.json();
      } catch {
        throw new Error(`${label} returned a non-JSON success response`);
      }
    }, requestTimeoutMs);
  } catch (error) {
    throw new Error(`${label} failed during a read-only request: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mutationOutcomeUnknown(error) {
  return new Error('Chrome Web Store mutation outcome is unknown; do not retry or rerun the mutation blindly. '
    + `Inspect fetchStatus and the Developer Dashboard, then resolve manually: ${error instanceof Error ? error.message : String(error)}`,
  { cause: error });
}

export async function fetchStoreStatus({
  publisherId,
  extensionId,
  accessToken,
  fetchImpl = fetch,
  deriveId = deriveExtensionId,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  validatePublisherId(publisherId);
  validateExtensionId(extensionId);
  const name = `publishers/${publisherId}/items/${extensionId}`;
  const status = await cwsJson(fetchImpl, `${API_BASE}/v2/${name}:fetchStatus`, {
    method: 'GET',
    headers: cwsHeaders(accessToken),
  }, 'Chrome Web Store fetchStatus', requestTimeoutMs);
  verifyItemIdentity(status, publisherId, extensionId, 'fetchStatus');
  invariant(status.takenDown === undefined || typeof status.takenDown === 'boolean',
    'Chrome Web Store status has an invalid takenDown flag');
  invariant(status.warned === undefined || typeof status.warned === 'boolean',
    'Chrome Web Store status has an invalid warned flag');
  invariant(deriveId(status.publicKey) === extensionId,
    'Chrome Web Store public key derives a different extension ID');
  return status;
}

export async function planStorePublish(options) {
  const status = await fetchStoreStatus(options);
  return { decision: decidePublishAction(status, options.version), status };
}

export async function planStoreUpload(options) {
  const status = await fetchStoreStatus(options);
  return { decision: decideUploadAction(status, options.version), status };
}

export async function planStoreSubmit(options) {
  const status = await fetchStoreStatus(options);
  return {
    decision: decideSubmitAction(status, options.version, {
      uploadLedgersVerified: options.uploadLedgersVerified,
      submitAttemptExists: options.submitAttemptExists,
    }),
    status,
  };
}

export function summarizeStatus(status) {
  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus, 'Published');
  const submittedVersion = revisionVersion(status.submittedItemRevisionStatus, 'Submitted');
  return {
    itemId: status.itemId,
    takenDown: status.takenDown === true,
    warned: status.warned === true,
    published: status.publishedItemRevisionStatus
      ? { state: status.publishedItemRevisionStatus.state, version: publishedVersion }
      : null,
    submitted: status.submittedItemRevisionStatus
      ? { state: status.submittedItemRevisionStatus.state, version: submittedVersion }
      : null,
    lastAsyncUploadState: status.lastAsyncUploadState ?? null,
  };
}

export async function uploadDraftToStore({
  publisherId,
  extensionId,
  accessToken,
  zipBytes,
  version,
  fetchImpl = fetch,
  deriveId = deriveExtensionId,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  parseChromeVersion(version, 3);
  invariant(Buffer.isBuffer(zipBytes) && zipBytes.length > 0, 'Release ZIP bytes are required');
  const initialStatus = await fetchStoreStatus({
    publisherId, extensionId, accessToken, fetchImpl, deriveId, requestTimeoutMs,
  });
  const decision = decideUploadAction(initialStatus, version);
  if (decision.action === 'noop') return { decision, status: initialStatus, mutated: false };

  const name = `publishers/${publisherId}/items/${extensionId}`;
  try {
    const upload = await boundedRequest(fetchImpl, `${API_BASE}/upload/v2/${name}:upload`, {
      method: 'POST',
      headers: cwsHeaders(accessToken, {
        'Content-Type': 'application/zip',
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-File-Name': `eipeek-${version}-chrome.zip`,
      }),
      body: zipBytes,
    }, 'Chrome Web Store upload', async (response) => {
      if (!response.ok) throw await responseError(response, 'Chrome Web Store upload');
      try {
        return await response.json();
      } catch {
        throw new Error('Chrome Web Store upload returned a non-JSON success response');
      }
    }, requestTimeoutMs);
    verifyItemIdentity(upload, publisherId, extensionId, 'upload');
    invariant(upload.uploadState === 'SUCCEEDED',
      `Staged rollout requires a direct synchronous SUCCEEDED upload response, received ${String(upload.uploadState)}`);
    invariant(upload.crxVersion === version,
      'Successful upload package version does not match request');
    return {
      decision: { action: 'uploaded', reason: 'synchronous_success', version },
      upload,
      mutated: true,
    };
  } catch (error) {
    throw mutationOutcomeUnknown(error);
  }
}

export async function submitDraftForReview(options) {
  invariant(isRecord(options), 'Submit options are required');
  invariant(!Object.hasOwn(options, 'zipBytes') && !Object.hasOwn(options, 'artifact'),
    'Review submission does not accept an artifact or ZIP bytes');
  const {
    publisherId,
    extensionId,
    accessToken,
    version,
    uploadLedgersVerified,
    fetchImpl = fetch,
    deriveId = deriveExtensionId,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  parseChromeVersion(version, 3);
  invariant(uploadLedgersVerified === true, 'Verified upload ledgers are required for review submission');
  const initialStatus = await fetchStoreStatus({
    publisherId, extensionId, accessToken, fetchImpl, deriveId, requestTimeoutMs,
  });
  const decision = decideSubmitAction(initialStatus, version, { uploadLedgersVerified: true });
  if (decision.action === 'noop') return { decision, status: initialStatus, mutated: false };

  const name = `publishers/${publisherId}/items/${extensionId}`;
  try {
    const publish = await boundedRequest(fetchImpl, `${API_BASE}/v2/${name}:publish`, {
      method: 'POST',
      headers: cwsHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(PUBLISH_REQUEST),
    }, 'Chrome Web Store publish', async (response) => {
      if (!response.ok) throw await responseError(response, 'Chrome Web Store publish');
      try {
        return await response.json();
      } catch {
        throw new Error('Chrome Web Store publish returned a non-JSON success response');
      }
    }, requestTimeoutMs);
    verifyItemIdentity(publish, publisherId, extensionId, 'publish');
    invariant(['PENDING_REVIEW', 'PUBLISHED'].includes(publish.state),
      `Publish returned unexpected state ${String(publish.state)}`);
    if (publish.warningInfo !== undefined) {
      invariant(isRecord(publish.warningInfo) && Array.isArray(publish.warningInfo.warnings),
        'Publish returned malformed warning information');
      invariant(publish.warningInfo.warnings.length === 0,
        'Publish unexpectedly returned warnings despite blockOnWarnings');
    }
    return {
      decision: { action: 'submitted', reason: publish.state.toLowerCase(), version },
      publish,
      mutated: true,
    };
  } catch (error) {
    throw mutationOutcomeUnknown(error);
  }
}

export async function publishToStore({
  publisherId,
  extensionId,
  accessToken,
  zipBytes,
  version,
  fetchImpl = fetch,
  deriveId = deriveExtensionId,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 10_000,
  pollTimeoutMs = 10 * 60_000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  parseChromeVersion(version, 3);
  invariant(Buffer.isBuffer(zipBytes) && zipBytes.length > 0, 'Release ZIP bytes are required');
  const initialStatus = await fetchStoreStatus({
    publisherId, extensionId, accessToken, fetchImpl, deriveId, requestTimeoutMs,
  });
  const decision = decidePublishAction(initialStatus, version);
  if (decision.action === 'noop') return { decision, status: initialStatus, mutated: false };

  const name = `publishers/${publisherId}/items/${extensionId}`;
  try {
    const upload = await boundedRequest(fetchImpl, `${API_BASE}/upload/v2/${name}:upload`, {
      method: 'POST',
      headers: cwsHeaders(accessToken, {
        'Content-Type': 'application/zip',
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-File-Name': `eipeek-${version}-chrome.zip`,
      }),
      body: zipBytes,
    }, 'Chrome Web Store upload', async (response) => {
      if (!response.ok) throw await responseError(response, 'Chrome Web Store upload');
      try {
        return await response.json();
      } catch {
        throw new Error('Chrome Web Store upload returned a non-JSON success response');
      }
    }, requestTimeoutMs);
    verifyItemIdentity(upload, publisherId, extensionId, 'upload');
    invariant(upload.uploadState === 'SUCCEEDED' || upload.uploadState === 'IN_PROGRESS',
      `Upload did not succeed: ${String(upload.uploadState)}`);
    if (upload.uploadState === 'SUCCEEDED') {
      invariant(upload.crxVersion === version, 'Successful upload package version does not match request');
    } else if (upload.crxVersion !== undefined) {
      invariant(upload.crxVersion === version, 'Uploaded package version does not match request');
    }

    if (upload.uploadState === 'IN_PROGRESS') {
      const deadline = Date.now() + pollTimeoutMs;
      let uploadState = 'IN_PROGRESS';
      while (uploadState === 'IN_PROGRESS') {
        invariant(Date.now() < deadline, 'Timed out waiting for Chrome Web Store upload processing');
        await sleep(pollIntervalMs);
        const polled = await fetchStoreStatus({
          publisherId, extensionId, accessToken, fetchImpl, deriveId, requestTimeoutMs,
        });
        uploadState = polled.lastAsyncUploadState;
        invariant(UPLOAD_STATES.has(uploadState), `Upload polling returned unexpected state ${String(uploadState)}`);
      }
      invariant(uploadState === 'SUCCEEDED', `Asynchronous upload ended in ${uploadState}`);
    }

    const publish = await boundedRequest(fetchImpl, `${API_BASE}/v2/${name}:publish`, {
      method: 'POST',
      headers: cwsHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(PUBLISH_REQUEST),
    }, 'Chrome Web Store publish', async (response) => {
      if (!response.ok) throw await responseError(response, 'Chrome Web Store publish');
      try {
        return await response.json();
      } catch {
        throw new Error('Chrome Web Store publish returned a non-JSON success response');
      }
    }, requestTimeoutMs);
    verifyItemIdentity(publish, publisherId, extensionId, 'publish');
    invariant(['PENDING_REVIEW', 'PUBLISHED'].includes(publish.state),
      `Publish returned unexpected state ${String(publish.state)}`);
    if (publish.warningInfo !== undefined) {
      invariant(isRecord(publish.warningInfo) && Array.isArray(publish.warningInfo.warnings),
        'Publish returned malformed warning information');
      invariant(publish.warningInfo.warnings.length === 0,
        'Publish unexpectedly returned warnings despite blockOnWarnings');
    }
    return { decision: { action: 'published', reason: publish.state.toLowerCase(), version }, publish, mutated: true };
  } catch (error) {
    throw mutationOutcomeUnknown(error);
  }
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  invariant([
    'validate-release', 'compare-release', 'claim-attempt', 'claim-upload-attempt',
    'record-upload-success', 'claim-upload-resume-attempt', 'record-recovery-upload-success',
    'verify-upload-ledgers', 'claim-submit-attempt',
    'status', 'plan', 'plan-upload', 'plan-submit', 'upload-draft', 'submit-review', 'publish',
  ].includes(operation),
  'Unknown Chrome Web Store helper operation');
  invariant(rest.length % 2 === 0, 'Every CLI option requires a value');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    invariant(/^--[a-z][a-z0-9-]*$/.test(flag), `Invalid CLI option ${String(flag)}`);
    const key = flag.slice(2);
    invariant(!Object.hasOwn(options, key), `Duplicate CLI option ${flag}`);
    options[key] = rest[index + 1];
  }
  return { operation, options };
}

function requireOption(options, name) {
  const value = options[name];
  invariant(typeof value === 'string' && value.length > 0, `--${name} is required`);
  return value;
}

function rolloutIdentityFromOptions(options) {
  return {
    repository: requireOption(options, 'repository'),
    repositoryId: requireOption(options, 'repository-id'),
    tag: requireOption(options, 'tag'),
    version: requireOption(options, 'version'),
    releaseId: requireOption(options, 'release-id'),
    assetId: requireOption(options, 'asset-id'),
    assetName: requireOption(options, 'asset-name'),
    assetSize: requireOption(options, 'asset-size'),
    tagObject: requireOption(options, 'tag-object'),
    commit: requireOption(options, 'commit'),
    sha256: requireOption(options, 'sha256'),
    publisherId: requireOption(options, 'publisher-id'),
    extensionId: requireOption(options, 'extension-id'),
    runId: requireOption(options, 'run-id'),
    runAttempt: requireOption(options, 'run-attempt'),
    runUrl: requireOption(options, 'run-url'),
    workflowRef: requireOption(options, 'workflow-ref'),
    workflowSha: requireOption(options, 'workflow-sha'),
    uploadResponseItemId: options['upload-response-item-id'],
    uploadResponseName: options['upload-response-name'],
    uploadState: options['upload-state'],
    crxVersion: options['crx-version'],
  };
}

const ROLLOUT_IDENTITY_OPTION_NAMES = Object.freeze([
  'repository', 'repository-id', 'tag', 'version', 'release-id', 'asset-id', 'asset-name',
  'asset-size', 'tag-object', 'commit', 'sha256', 'publisher-id', 'extension-id', 'run-id',
  'run-attempt', 'run-url', 'workflow-ref', 'workflow-sha',
]);

function requireOnlyRecoveryOptions(options, extra = []) {
  const allowed = new Set([...ROLLOUT_IDENTITY_OPTION_NAMES, ...extra]);
  const unexpected = Object.keys(options).filter((name) => !allowed.has(name));
  invariant(unexpected.length === 0,
    `Recovery operation does not accept option --${unexpected[0]}; prior run and issue IDs are derived from the canonical ledger`);
}

async function appendOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => {
    invariant(/^[a-z][a-z0-9_]*$/.test(key), 'Unsafe GitHub output key');
    const text = String(value);
    invariant(!/[\r\n]/.test(text), `Unsafe multiline GitHub output ${key}`);
    return `${key}=${text}`;
  });
  await appendFile(outputPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
}

async function appendSummary(title, value) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const text = `### ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
  if (summaryPath) await appendFile(summaryPath, text, { encoding: 'utf8' });
  else console.log(`${title}: ${JSON.stringify(value)}`);
}

async function main(argv) {
  const { operation, options } = parseArguments(argv);
  const publisherId = options['publisher-id'];
  const extensionId = options['extension-id'];
  if (operation === 'validate-release') {
    const tag = requireOption(options, 'tag');
    invariant(options['event-release-id'] !== undefined || options.operation !== 'publish',
      'Manual combined publish validation is unavailable');
    if (options['event-release-id'] === undefined
      && ['upload', 'resume-upload', 'submit'].includes(options.operation)) {
      requireManualPublishTag(tag);
      if (options.operation === 'upload') requireUploadConfirmation(tag, options.confirmation ?? '');
      else if (options.operation === 'resume-upload') {
        requireResumeUploadConfirmation(tag, options.confirmation ?? '');
      } else requireSubmitConfirmation(tag, options.confirmation ?? '');
    }
    const expected = {
      releaseId: options['expected-release-id'],
      assetId: options['expected-asset-id'],
      assetSize: options['expected-asset-size'],
      sha256: options['expected-sha256'],
      tagObject: options['expected-tag-object'],
      commit: options['expected-commit'],
    };
    const result = await resolveGitHubRelease({
      repository: requireOption(options, 'repository'),
      tag,
      token: process.env.GITHUB_TOKEN,
      artifactPath: requireOption(options, 'artifact'),
      eventReleaseId: options['event-release-id'],
      expected,
    });
    await appendOutput({
      tag: result.tag,
      version: result.version,
      release_id: result.releaseId,
      asset_id: result.assetId,
      asset_size: result.assetSize,
      asset_name: result.assetName,
      sha256: result.sha256,
      tag_object: result.tagObject,
      commit: result.commit,
    });
    await appendSummary('Validated Chrome Web Store release', {
      tag: result.tag,
      releaseId: result.releaseId,
      assetId: result.assetId,
      assetSize: result.assetSize,
      sha256: result.sha256,
      tagObject: result.tagObject,
      commit: result.commit,
      immutable: result.immutable,
      manifestVersion: result.manifest.version,
    });
    return;
  }

  if (operation === 'compare-release') {
    const result = await compareZipToDirectory(requireOption(options, 'artifact'), requireOption(options, 'build-directory'));
    await appendSummary('Release provenance comparison', {
      version: requireOption(options, 'version'),
      filesCompared: result.fileCount,
      result: 'all normalized paths and file bytes match',
    });
    return;
  }

  if (operation === 'claim-attempt') {
    const result = await claimPublishAttempt({
      repository: requireOption(options, 'repository'),
      tag: requireOption(options, 'tag'),
      version: requireOption(options, 'version'),
      releaseId: requireOption(options, 'release-id'),
      assetId: requireOption(options, 'asset-id'),
      commit: requireOption(options, 'commit'),
      sha256: requireOption(options, 'sha256'),
      runUrl: requireOption(options, 'run-url'),
      token: process.env.GITHUB_TOKEN,
    });
    await appendOutput({ issue_number: result.issueNumber, issue_url: result.issueUrl });
    await appendSummary('Chrome Web Store pre-mutation attempt ledger', {
      releaseTag: result.marker.payload.releaseTag,
      releaseVersion: result.marker.payload.releaseVersion,
      sha256: result.marker.payload.sha256,
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
      warning: 'Pre-mutation attempt only; verify the Developer Dashboard before any administrator bypass.',
    });
    return;
  }

  if (['claim-upload-attempt', 'record-upload-success', 'claim-upload-resume-attempt',
    'record-recovery-upload-success', 'verify-upload-ledgers', 'claim-submit-attempt']
    .includes(operation)) {
    if (operation === 'claim-upload-resume-attempt') requireOnlyRecoveryOptions(options);
    if (operation === 'record-recovery-upload-success') requireOnlyRecoveryOptions(options, [
      'upload-response-item-id', 'upload-response-name', 'upload-state', 'crx-version',
    ]);
    const identity = rolloutIdentityFromOptions(options);
    let result;
    let title;
    if (operation === 'claim-upload-attempt') {
      result = await claimUploadAttempt({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Chrome Web Store staged upload attempt ledger';
    } else if (operation === 'record-upload-success') {
      result = await recordUploadSuccess({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Chrome Web Store synchronous upload success ledger';
    } else if (operation === 'claim-upload-resume-attempt') {
      result = await claimUploadResumeAttempt({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Chrome Web Store one-shot upload resume attempt ledger';
    } else if (operation === 'record-recovery-upload-success') {
      result = await recordRecoveryUploadSuccess({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Chrome Web Store recovered synchronous upload success ledger';
    } else if (operation === 'verify-upload-ledgers') {
      result = await verifyUploadLedgers({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Verified Chrome Web Store upload ledgers';
    } else {
      result = await claimSubmitAttempt({ ...identity, token: process.env.GITHUB_TOKEN });
      title = 'Chrome Web Store staged submit attempt ledger';
    }
    await appendOutput(Object.fromEntries(Object.entries({
      issue_number: result.issueNumber,
      issue_url: result.issueUrl,
      upload_attempt_issue_number: result.uploadAttemptIssueNumber,
      upload_attempt_issue_url: result.uploadAttemptIssueUrl,
      upload_success_issue_number: result.uploadSuccessIssueNumber,
      upload_success_issue_url: result.uploadSuccessIssueUrl,
      recovery_chain: result.recoveryChain,
      upload_resume_issue_number: result.uploadResumeIssueNumber,
      upload_resume_issue_url: result.uploadResumeIssueUrl,
      submit_attempt_exists: result.submitAttemptExists,
      submit_attempt_issue_number: result.submitAttemptIssueNumber,
      submit_attempt_issue_url: result.submitAttemptIssueUrl,
    }).filter(([, value]) => value !== undefined)));
    await appendSummary(title, result.marker ? {
      schema: result.marker.payload.schema,
      releaseTag: result.marker.payload.releaseTag,
      sha256: result.marker.payload.sha256,
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
    } : result);
    return;
  }

  const accessToken = process.env.CWS_ACCESS_TOKEN;
  if (operation === 'status') {
    const status = await fetchStoreStatus({ publisherId, extensionId, accessToken });
    const summary = summarizeStatus(status);
    await appendSummary('Chrome Web Store status (read-only)', summary);
    invariant(!summary.takenDown, 'Chrome Web Store item is taken down');
    invariant(!summary.warned, 'Chrome Web Store item has an unresolved policy warning');
    return;
  }

  const version = requireOption(options, 'version');
  if (['plan', 'plan-upload', 'plan-submit'].includes(operation)) {
    const result = operation === 'plan-submit'
      ? await planStoreSubmit({
        publisherId,
        extensionId,
        accessToken,
        version,
        uploadLedgersVerified: options['upload-ledgers-verified'] === 'true',
        submitAttemptExists: options['submit-attempt-exists'] === 'true',
      })
      : await (operation === 'plan-upload' ? planStoreUpload : planStorePublish)({
        publisherId, extensionId, accessToken, version,
      });
    await appendOutput({ action: result.decision.action, reason: result.decision.reason });
    await appendSummary('Chrome Web Store mutation plan (read-only)', {
      version,
      decision: result.decision,
      status: summarizeStatus(result.status),
    });
    return;
  }
  if (operation === 'submit-review') {
    invariant(options.artifact === undefined, 'submit-review does not accept --artifact');
    const result = await submitDraftForReview({
      publisherId,
      extensionId,
      accessToken,
      version,
      uploadLedgersVerified: options['upload-ledgers-verified'] === 'true',
    });
    await appendSummary('Chrome Web Store review submission result', {
      version, mutated: result.mutated, decision: result.decision, itemId: extensionId,
    });
    return;
  }
  const zipBytes = await readFile(requireOption(options, 'artifact'));
  const result = operation === 'upload-draft'
    ? await uploadDraftToStore({ publisherId, extensionId, accessToken, zipBytes, version })
    : await publishToStore({ publisherId, extensionId, accessToken, zipBytes, version });
  if (operation === 'upload-draft') {
    invariant(result.mutated === true,
      'Store state changed after the upload-attempt ledger; no upload was performed and no success ledger may be created');
  }
  await appendOutput({
    mutated: result.mutated,
    ...(operation === 'upload-draft' && result.mutated ? {
      upload_response_item_id: result.upload.itemId,
      upload_response_name: result.upload.name,
      upload_state: result.upload.uploadState,
      crx_version: result.upload.crxVersion,
    } : {}),
  });
  await appendSummary(operation === 'upload-draft'
    ? 'Chrome Web Store draft upload result'
    : 'Chrome Web Store publish result', {
    version,
    mutated: result.mutated,
    decision: result.decision,
    itemId: extensionId,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`chrome-web-store: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
