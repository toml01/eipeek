import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  compareZipToDirectory,
  compareChromeVersions,
  decidePublishAction,
  deriveExtensionId,
  fetchStoreStatus,
  parseChromeVersion,
  parseReleaseTag,
  parseZipFiles,
  planStorePublish,
  publishToStore,
  requireManualPublishTag,
  requirePublishConfirmation,
  validateManifest,
  validatePublisherId,
  validateReleaseRecord,
  verifyItemIdentity,
} = chromeWebStore;

const PUBLISHER_ID = '00000000-0000-4000-8000-000000000000';
const name = `publishers/${PUBLISHER_ID}/items/${EXPECTED_EXTENSION_ID}`;
const deriveExpectedId = () => EXPECTED_EXTENSION_ID;

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
}>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents ?? entry.name);
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
    locals.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + contents.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

describe('release and Chrome version validation', () => {
  it('accepts strict release tags and exact manual confirmation', () => {
    expect(parseReleaseTag('v0.3.0')).toBe('0.3.0');
    expect(() => requirePublishConfirmation('v0.3.0', 'publish v0.3.0')).not.toThrow();
    expect(() => requireManualPublishTag('v0.3.0')).not.toThrow();
    expect(() => requireManualPublishTag('v0.4.0')).toThrow(/restricted to legacy/);
    expect(() => requirePublishConfirmation('v0.3.0', 'publish 0.3.0')).toThrow(/exactly/);
    expect(() => parseReleaseTag('v01.3.0')).toThrow(/strict/);
    expect(() => parseReleaseTag('v0.3.0/asset')).toThrow(/strict/);
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
  it('puts an exact-SHA durable attempt marker between read-only planning and mutation', async () => {
    const workflow = await readFile(new URL('../.github/workflows/chrome-web-store.yml', import.meta.url), 'utf8');
    const plan = workflow.indexOf('- name: Plan from current store status without mutation');
    const restore = workflow.indexOf('- name: Restore exact pre-mutation attempt marker');
    const save = workflow.indexOf('- name: Save exact pre-mutation attempt marker');
    const prove = workflow.indexOf('- name: Verify durable marker before mutation');
    const mutate = workflow.indexOf('- name: Upload and submit for automatic publication after review');
    expect([plan, restore, save, prove, mutate]).toEqual([...new Set([plan, restore, save, prove, mutate])]);
    expect(plan).toBeGreaterThan(0);
    expect(plan).toBeLessThan(restore);
    expect(restore).toBeLessThan(save);
    expect(save).toBeLessThan(prove);
    expect(prove).toBeLessThan(mutate);
    expect(workflow.match(/actions\/cache\/(?:restore|save)@0057852bfaa89a56745cba8c7296529d2fc39830/g))
      .toHaveLength(3);
    expect(workflow).toContain('key: cws-publish-attempt-${{ needs.validate.outputs.sha256 }}');
    expect(workflow).toContain("inputs.operation == 'publish' && inputs.release_tag == 'v0.3.0'");
    expect(workflow.slice(mutate, mutate + 150)).toContain("if: steps.plan.outputs.action == 'upload'");
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

  it('uploads once and publishes once with the required safe body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(status()))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, crxVersion: '0.3.0', uploadState: 'SUCCEEDED',
      }))
      .mockResolvedValueOnce(jsonResponse({
        name, itemId: EXPECTED_EXTENSION_ID, state: 'PENDING_REVIEW',
      }));
    const result = await publishToStore({
      publisherId: PUBLISHER_ID,
      extensionId: EXPECTED_EXTENSION_ID,
      accessToken: 'test-token',
      zipBytes: Buffer.from('zip'),
      version: '0.3.0',
      fetchImpl: fetchMock,
      deriveId: deriveExpectedId,
    });
    expect(result.mutated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toMatch('/upload/v2/');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: Buffer.from('zip') });
    expect(fetchMock.mock.calls[2]![0]).toMatch(/:publish$/);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string)).toEqual(PUBLISH_REQUEST);
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
    })).rejects.toThrow(/outcome is unknown; do not retry or rerun publish blindly/i);
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
});
