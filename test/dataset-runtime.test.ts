import { describe, expect, it, vi } from 'vitest';
import { DatasetRuntime } from '../src/core/dataset-runtime';
import type {
  DatabaseIndexResponse,
  DatabaseLookupResponse,
  LookupRequest,
} from '../src/core/database-messages';
import type { Proposal } from '../src/core/types';

const proposal = (n: number, title = `Proposal ${n}`): Proposal => ({
  n,
  t: title,
  d: '',
  s: 'Draft',
  ty: 'Standards Track',
  c: 'Core',
  k: 'eip',
  disc: '',
  cr: '2026-08-24',
  req: [],
});

const index = (
  revision: number,
  mergedNumbers: number[],
  unmergedNumbers: number[],
): DatabaseIndexResponse => ({
  revision,
  databaseVersion: 2026082401 + revision,
  mergedNumbers,
  unmergedNumbers,
});

describe('content-script dataset activation', () => {
  it('uses the received precomputed arrays exactly rather than deriving an index from proposals', () => {
    const runtime = new DatasetRuntime([1], [2]);

    expect(runtime.activateIndex(index(1, [7000], [8000]))).toBe(true);
    expect(runtime.classify(1, true)).toBe('unknown');
    expect(runtime.classify(7000, true)).toBe('merged');
    expect(runtime.classify(8000, false)).toBe('hidden');
    expect(runtime.classify(8000, true)).toBe('unmerged');
  });

  it('clears metadata hits and remembered misses on activation', async () => {
    const runtime = new DatasetRuntime([1], [2]);
    const firstSender = vi.fn(async ({ revision, numbers }: LookupRequest) => ({
      revision,
      proposals: Object.fromEntries(numbers.map((number) => [number, number === 1 ? [proposal(1, 'old')] : []])),
    }));

    expect((await runtime.lookup([1, 2], firstSender)).get(1)?.[0]?.t).toBe('old');
    await runtime.lookup([1, 2], firstSender);
    expect(firstSender).toHaveBeenCalledTimes(1);

    runtime.activateIndex(index(1, [1, 3], [4]));
    const secondSender = vi.fn(async ({ revision, numbers }: LookupRequest) => ({
      revision,
      proposals: Object.fromEntries(numbers.map((number) => [number, [proposal(number, 'new')]])),
    }));

    const refreshed = await runtime.lookup([1, 2], secondSender);
    expect(secondSender).toHaveBeenCalledTimes(1);
    expect(refreshed.get(1)?.[0]?.t).toBe('new');
    expect(refreshed.get(2)?.[0]?.t).toBe('new');
  });

  it('rejects stale in-flight lookup results after an activation', async () => {
    const runtime = new DatasetRuntime([1], []);
    let resolve!: (value: DatabaseLookupResponse) => void;
    const oldReply = new Promise<DatabaseLookupResponse>((done) => {
      resolve = done;
    });
    const pending = runtime.lookup([1], () => oldReply);

    runtime.activateIndex(index(1, [1], []));
    resolve({ revision: 0, proposals: { 1: [proposal(1, 'stale')] } });
    expect((await pending).has(1)).toBe(false);

    const fresh = await runtime.lookup([1], async (request) => ({
      revision: request.revision,
      proposals: { 1: [proposal(1, 'fresh')] },
    }));
    expect(fresh.get(1)?.[0]?.t).toBe('fresh');
  });

  it('rejects a response from a different activation revision', async () => {
    const runtime = new DatasetRuntime([1], []);
    const result = await runtime.lookup([1], async () => ({
      revision: 99,
      proposals: { 1: [proposal(1)] },
    }));
    expect(result.has(1)).toBe(false);
  });

  it.each([
    index(1, [2, 1], []),
    index(1, [1, 1], []),
    index(1, [1], [1]),
    index(1, [100_000], []),
  ])('rejects malformed remote indexes without changing the bundled one', (bad) => {
    const runtime = new DatasetRuntime([1], [2]);
    expect(runtime.activateIndex(bad)).toBe(false);
    expect(runtime.classify(1, true)).toBe('merged');
    expect(runtime.classify(2, true)).toBe('unmerged');
  });
});
