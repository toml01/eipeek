import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bundledPayloadJson from '../data/database.payload.json';
import {
  DATABASE_ARTIFACT_SCHEMA_VERSION,
  DATABASE_SIGNATURE_ALGORITHM,
  MAX_DATABASE_ARTIFACT_BYTES,
  verifySignedDatabase,
  type DatabasePayload,
  type SignedDatabaseEnvelope,
} from '../src/core/database-artifact';
import {
  DATABASE_UPDATE_ACCEPT,
  DATABASE_UPDATE_URL,
  DATABASE_VERSION_HINT_URL,
  MAX_DATABASE_VERSION_HINT_BYTES,
  DATABASE_STATE_STORAGE_KEY,
  DatabaseManager,
  type DatabaseStorage,
} from '../src/core/database-manager';
import { BUNDLED_DATABASE_PAYLOAD_SHA256 } from '../src/core/database.generated';
import { DatasetRuntime } from '../src/core/dataset-runtime';

const bundledPayload = bundledPayloadJson as DatabasePayload;
const TEST_KEY_ID = 'database-manager-test-key';
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKey = keys.publicKey.export({ format: 'jwk' });

class MemoryStorage implements DatabaseStorage {
  values: Record<string, unknown> = {};
  failStateWrites = false;

  async get(requested: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      requested
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, structuredClone(this.values[key])]),
    );
  }

  async set(values: Record<string, unknown>): Promise<void> {
    if (this.failStateWrites && Object.hasOwn(values, DATABASE_STATE_STORAGE_KEY)) {
      throw new Error('simulated state-pointer failure');
    }
    for (const [key, value] of Object.entries(values)) this.values[key] = structuredClone(value);
  }
}

function makePayload(version: number, title = 'Signed update title'): DatabasePayload {
  const payload = structuredClone(bundledPayload);
  payload.keyId = TEST_KEY_ID;
  payload.databaseVersion = version;
  payload.proposals[0]!.t = title;
  return payload;
}

function signPayload(payload: DatabasePayload): string {
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  const signature = sign('sha256', bytes, { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  const envelope: SignedDatabaseEnvelope = {
    artifactSchemaVersion: DATABASE_ARTIFACT_SCHEMA_VERSION,
    keyId: TEST_KEY_ID,
    algorithm: DATABASE_SIGNATURE_ALGORITHM,
    payloadEncoding: 'base64',
    payload: bytes.toString('base64'),
    signature: signature.toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function invalidateSignature(artifact: string): string {
  const envelope = JSON.parse(artifact) as SignedDatabaseEnvelope;
  envelope.signature = `${envelope.signature[0] === 'A' ? 'B' : 'A'}${envelope.signature.slice(1)}`;
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

const verifyTestArtifact = (raw: string) =>
  verifySignedDatabase(raw, { publicKey, expectedKeyId: TEST_KEY_ID });
const response = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
const versionHint = (databaseVersion: number) => `${JSON.stringify({
  schemaVersion: 1,
  databaseVersion,
  keyId: bundledPayload.keyId,
}, null, 2)}\n`;

function manager(
  storage: MemoryStorage,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof DatabaseManager>[0]> = {},
) {
  return new DatabaseManager({
    storage,
    bundledPayload,
    bundledPayloadDigest: BUNDLED_DATABASE_PAYLOAD_SHA256,
    fetcher,
    verify: verifyTestArtifact,
    now: () => new Date('2026-08-24T12:34:56.000Z'),
    ...overrides,
  });
}

describe('manual database manager', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('never fetches during startup, status, index retrieval, or page lookup', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const database = manager(storage, fetcher);

    await database.initialize();
    await database.status();
    await database.getNumberIndex();
    await database.lookup([1, 7702], 0);

    expect(fetcher).not.toHaveBeenCalled();
    expect((await database.status()).source).toBe('bundled');
  });

  it('fetches only the fixed credentialless GitHub Contents URL after an explicit check', async () => {
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response(artifact));
    const database = manager(storage, fetcher);

    const result = await database.checkForUpdates();

    expect(result.outcome).toBe('activated');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(DATABASE_UPDATE_URL);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: DATABASE_UPDATE_ACCEPT },
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(
      ['cache', 'credentials', 'headers', 'method', 'mode', 'redirect', 'referrerPolicy', 'signal'].sort(),
    );
  });

  it('stages, rereads, reverifies, and atomically activates a valid update', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version));
    const verify = vi.fn(verifyTestArtifact);
    const database = manager(storage, async () => response(artifact), { verify });

    const result = await database.checkForUpdates();
    const lookup = await database.lookup([bundledPayload.proposals[0]!.n], result.status.revision);

    expect(result.status).toMatchObject({ source: 'downloaded', activeVersion: version, highWaterVersion: version });
    expect(lookup.proposals[bundledPayload.proposals[0]!.n]![0]!.t).toBe('Signed update title');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(storage.values[DATABASE_STATE_STORAGE_KEY]).toMatchObject({
      activeSource: 'downloaded',
      activeVersion: version,
      highWaterVersion: version,
      revision: 1,
    });
    expect(Object.keys(storage.values).some((key) => key.includes('.slot.'))).toBe(true);
  });

  it('publishes only a small revision signal after the atomic pointer commits', async () => {
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    const observed: Array<{ signal: { revision: number }; committed: boolean }> = [];
    const database = manager(storage, async () => response(artifact), {
      notifyActivation: async (signal) => {
        observed.push({ signal, committed: Object.hasOwn(storage.values, DATABASE_STATE_STORAGE_KEY) });
      },
    });

    await database.checkForUpdates();

    expect(observed).toEqual([{ signal: { revision: 1 }, committed: true }]);
    expect(JSON.stringify(observed[0]!.signal).length).toBeLessThan(32);
  });

  it('feeds changed signed indexes and titles through the content runtime flow', async () => {
    const changedNumber = 9998;
    const payload = makePayload(bundledPayload.databaseVersion + 1, 'Live changed title');
    payload.proposals[0]!.aka = [...(payload.proposals[0]!.aka ?? []), changedNumber].sort(
      (left, right) => left - right,
    );
    payload.mergedNumbers = [...payload.mergedNumbers, changedNumber].sort((left, right) => left - right);
    const database = manager(storage, async () => response(signPayload(payload)));
    const contentRuntime = new DatasetRuntime(bundledPayload.mergedNumbers, bundledPayload.unmergedNumbers);

    await database.checkForUpdates();
    expect(contentRuntime.activateIndex(await database.getNumberIndex())).toBe(true);
    expect(contentRuntime.classify(changedNumber, false)).toBe('merged');
    const lookup = await contentRuntime.lookup([changedNumber], (request) =>
      database.lookup(request.numbers, request.revision),
    );
    expect(lookup.get(changedNumber)?.[0]?.t).toBe('Live changed title');
  });

  it('reverifies and recovers a valid persisted active database after worker restart', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version, 'Persisted title'));
    await manager(storage, async () => response(artifact)).checkForUpdates();
    const restartFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const verify = vi.fn(verifyTestArtifact);

    const restarted = manager(storage, restartFetch, { verify });
    await restarted.initialize();
    const status = await restarted.status();
    const lookup = await restarted.lookup([bundledPayload.proposals[0]!.n], status.revision);

    expect(restartFetch).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ source: 'downloaded', activeVersion: version });
    expect(lookup.proposals[bundledPayload.proposals[0]!.n]![0]!.t).toBe('Persisted title');
  });

  it('falls back to bundled data but preserves high-water state when persisted bytes are corrupt', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version));
    await manager(storage, async () => response(artifact)).checkForUpdates();
    const slotKey = Object.keys(storage.values).find((key) => key.includes('.slot.'))!;
    (storage.values[slotKey] as any).envelope = '{"tampered":true}';

    const restarted = manager(storage, vi.fn());
    const status = await restarted.status();

    expect(status).toMatchObject({
      source: 'bundled',
      activeVersion: bundledPayload.databaseVersion,
      highWaterVersion: version,
    });
    expect(storage.values[slotKey]).toBeDefined();
  });

  it('restores bundled data without lowering the high-water version', async () => {
    const newerVersion = bundledPayload.databaseVersion + 2;
    const newer = signPayload(makePayload(newerVersion));
    const older = signPayload(makePayload(bundledPayload.databaseVersion + 1, 'Older update'));
    const queue = [newer, older];
    const database = manager(storage, async () => response(queue.shift()!));

    await database.checkForUpdates();
    const restored = await database.restoreBundled();
    expect(restored.status).toMatchObject({
      source: 'bundled',
      activeVersion: bundledPayload.databaseVersion,
      highWaterVersion: newerVersion,
    });
    await expect(database.checkForUpdates()).rejects.toMatchObject({ code: 'rollback' });
    expect(await database.status()).toMatchObject({ source: 'bundled', highWaterVersion: newerVersion });
  });

  it('rejects same-version changed content and keeps the previous active data', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const first = signPayload(makePayload(version, 'First accepted title'));
    const conflicting = signPayload(makePayload(version, 'Conflicting title'));
    const queue = [first, conflicting];
    const database = manager(storage, async () => response(queue.shift()!));

    await database.checkForUpdates();
    await expect(database.checkForUpdates()).rejects.toMatchObject({ code: 'version-conflict' });
    const status = await database.status();
    const lookup = await database.lookup([bundledPayload.proposals[0]!.n], status.revision);
    expect(status).toMatchObject({ source: 'downloaded', activeVersion: version });
    expect(lookup.proposals[bundledPayload.proposals[0]!.n]![0]!.t).toBe('First accepted title');
  });

  it.each([
    [
      'invalid signature',
      () => invalidateSignature(signPayload(makePayload(bundledPayload.databaseVersion + 1))),
      'invalid-signature',
    ],
    [
      'signed invalid schema',
      () => {
        const bad = makePayload(bundledPayload.databaseVersion + 1) as any;
        bad.proposals[0].disc = 'javascript:alert(1)';
        return signPayload(bad);
      },
      'invalid-schema',
    ],
  ])('rejects %s and retains the valid fallback', async (_name, artifact, code) => {
    const database = manager(storage, async () => response(artifact()));
    await expect(database.checkForUpdates()).rejects.toMatchObject({ code });
    expect(await database.status()).toMatchObject({
      source: 'bundled',
      activeVersion: bundledPayload.databaseVersion,
      lastCheckOutcome: 'error',
    });
  });

  it('keeps the previous active state when the atomic pointer write fails', async () => {
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    const notifyActivation = vi.fn(async () => {});
    const database = manager(storage, async () => response(artifact), { notifyActivation });
    storage.failStateWrites = true;

    await expect(database.checkForUpdates()).rejects.toMatchObject({ code: 'storage' });
    expect(await database.status()).toMatchObject({ source: 'bundled', revision: 0 });
    expect(Object.keys(storage.values).some((key) => key.includes('.slot.'))).toBe(true);
    expect(notifyActivation).not.toHaveBeenCalled();
  });

  it('keeps bundled data active on HTTP and network failure', async () => {
    const http = manager(storage, async () => response('not found', 404));
    await expect(http.checkForUpdates()).rejects.toMatchObject({ code: 'http' });
    expect(await http.status()).toMatchObject({ source: 'bundled' });

    const network = manager(new MemoryStorage(), async () => {
      throw new TypeError('offline');
    });
    await expect(network.checkForUpdates()).rejects.toMatchObject({ code: 'network' });
    expect(await network.status()).toMatchObject({ source: 'bundled' });
  });

  it('rejects an oversized response from its Content-Length before reading the body', async () => {
    const database = manager(storage, async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MAX_DATABASE_ARTIFACT_BYTES + 1) },
      }),
    );
    await expect(database.checkForUpdates()).rejects.toMatchObject({ code: 'artifact-too-large' });
    expect(await database.status()).toMatchObject({ source: 'bundled' });
  });

  it('allows only one database mutation at a time', async () => {
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const database = manager(storage, async () => {
      await gate;
      return response(artifact);
    });

    const first = database.checkForUpdates();
    await vi.waitFor(async () => {
      expect((await database.status()).busy).toBe(true);
    });
    await expect(database.restoreBundled()).rejects.toMatchObject({ code: 'busy' });
    release();
    await expect(first).resolves.toMatchObject({ outcome: 'activated' });
  });

  it('aborts a request at the configured timeout', async () => {
    const fetcher = vi.fn(
      async (_url: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const database = manager(storage, fetcher, { timeoutMs: 5 });

    await expect(database.checkForUpdates()).rejects.toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite storage when the already-active signed database is checked again', async () => {
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    const database = manager(storage, async () => response(artifact));
    const first = await database.checkForUpdates();
    const stateDigest = createHash('sha256')
      .update(JSON.stringify(storage.values[DATABASE_STATE_STORAGE_KEY]))
      .digest('hex');
    const second = await database.checkForUpdates();

    expect(second.outcome).toBe('current');
    expect(second.status.revision).toBe(first.status.revision);
    expect(
      createHash('sha256').update(JSON.stringify(storage.values[DATABASE_STATE_STORAGE_KEY])).digest('hex'),
    ).toBe(stateDigest);
  });
});

describe('automatic database manager', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('fetches only the small fixed hint when it is not above the durable high-water version', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      response(versionHint(bundledPayload.databaseVersion)));
    const database = manager(storage, fetcher);

    const result = await database.checkForUpdates('automatic');

    expect(result.outcome).toBe('current');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(DATABASE_VERSION_HINT_URL);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      headers: { Accept: DATABASE_UPDATE_ACCEPT },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(result.status).toMatchObject({ lastCheckOutcome: 'current', source: 'bundled' });
  });

  it('does not reactivate a previously accepted remote version after restore', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version));
    const fetcher = vi.fn(async (url: string) =>
      response(url === DATABASE_VERSION_HINT_URL ? versionHint(version) : artifact));
    const database = manager(storage, fetcher);

    await database.checkForUpdates();
    await database.restoreBundled();
    fetcher.mockClear();
    const result = await database.checkForUpdates('automatic');

    expect(result).toMatchObject({ outcome: 'current', status: { source: 'bundled', highWaterVersion: version } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(DATABASE_VERSION_HINT_URL);
  });

  it('downloads, verifies, and activates only when the verified version agrees with a higher hint', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version));
    const fetcher = vi.fn(async (url: string) =>
      response(url === DATABASE_VERSION_HINT_URL ? versionHint(version) : artifact));
    const database = manager(storage, fetcher);

    const result = await database.checkForUpdates('automatic');

    expect(result).toMatchObject({ outcome: 'activated', status: { activeVersion: version, source: 'downloaded' } });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([DATABASE_VERSION_HINT_URL, DATABASE_UPDATE_URL]);
  });

  it.each([
    ['malformed', '{"schemaVersion":1}', 'invalid-hint'],
    ['extra-field', JSON.stringify({ schemaVersion: 1, databaseVersion: bundledPayload.databaseVersion + 1, keyId: bundledPayload.keyId, url: 'x' }), 'invalid-hint'],
  ])('rejects a %s hint without fetching the artifact', async (_name, hint, code) => {
    const fetcher = vi.fn(async () => response(hint));
    const database = manager(storage, fetcher);

    await expect(database.checkForUpdates('automatic')).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await database.status()).toMatchObject({ source: 'bundled', lastCheckOutcome: 'error' });
  });

  it('rejects an oversized hint without reading an artifact', async () => {
    const fetcher = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_DATABASE_VERSION_HINT_BYTES + 1) },
    }));
    const database = manager(storage, fetcher);

    await expect(database.checkForUpdates('automatic')).rejects.toMatchObject({ code: 'hint-too-large' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a signed artifact whose version disagrees with the higher hint', async () => {
    const hinted = bundledPayload.databaseVersion + 2;
    const artifact = signPayload(makePayload(bundledPayload.databaseVersion + 1));
    const fetcher = vi.fn(async (url: string) =>
      response(url === DATABASE_VERSION_HINT_URL ? versionHint(hinted) : artifact));
    const database = manager(storage, fetcher);

    await expect(database.checkForUpdates('automatic')).rejects.toMatchObject({ code: 'hint-mismatch' });
    expect(await database.status()).toMatchObject({ source: 'bundled', lastCheckOutcome: 'error' });
  });

  it('shares the mutation lock without allowing an overlap to replace the in-flight result', async () => {
    const version = bundledPayload.databaseVersion + 1;
    const artifact = signPayload(makePayload(version));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (url: string) => {
      await gate;
      return response(url === DATABASE_VERSION_HINT_URL ? versionHint(version) : artifact);
    });
    const database = manager(storage, fetcher);

    const automatic = database.checkForUpdates('automatic');
    await vi.waitFor(async () => expect((await database.status()).busy).toBe(true));
    await expect(database.checkForUpdates('manual')).rejects.toMatchObject({ code: 'busy' });
    release();
    await expect(automatic).resolves.toMatchObject({ outcome: 'activated' });
    expect(await database.status()).toMatchObject({ activeVersion: version, lastCheckOutcome: 'activated' });
  });

  it('records and publishes automatic network failures without changing active data', async () => {
    const notifyStatusChange = vi.fn(async () => {});
    const database = manager(storage, async () => { throw new TypeError('offline'); }, { notifyStatusChange });

    await expect(database.checkForUpdates('automatic')).rejects.toMatchObject({ code: 'network' });
    expect(await database.status()).toMatchObject({ source: 'bundled', lastCheckOutcome: 'error' });
    expect(notifyStatusChange).toHaveBeenCalledTimes(1);
  });
});
