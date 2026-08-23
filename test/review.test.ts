import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askForum,
  cacheHit,
  classifyDiscussion,
  loadReviewCache,
  type Proposal,
  retryDelayMs,
  saveReviewCache,
} from '../scripts/review-dataset';

const proposal = { n: 8400, t: 'x', k: 'erc', disc: 'https://example.test/t/x/1' } as Proposal;

// Headers by default, so production code may read them without guarding.
const stub = (r: Partial<Response>) => ({ headers: new Headers(), ...r }) as Response;

const respond = (r: Partial<Response> | Error) =>
  vi.stubGlobal('fetch', async () => {
    if (r instanceof Error) throw r;
    return stub(r);
  });

/** Answers each attempt in turn, so a retry can be given a different response. */
const respondInTurn = (...rs: Partial<Response>[]) => {
  let i = 0;
  const fetchMock = vi.fn(async () => stub(rs[Math.min(i++, rs.length - 1)]!));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe('askForum', () => {
  it('passes when the forum slug agrees', async () => {
    respond({ ok: true, status: 200, url: 'https://x/t/erc-8400-title/1' });
    expect(await askForum(proposal)).toEqual({ kind: 'match' });
  });

  it('reports a disagreement with the number the forum uses', async () => {
    respond({ ok: true, status: 200, url: 'https://x/t/erc-8351-title/1' });
    expect(await askForum(proposal)).toMatchObject({ kind: 'disagrees', forum: 8351 });
  });

  it('says so when the thread title carries no number', async () => {
    // Real example: "new-erc-wallet-call-simulation-api".
    respond({ ok: true, status: 200, url: 'https://x/t/new-erc-wallet-call-simulation-api/1' });
    expect(await askForum(proposal)).toMatchObject({ kind: 'no-number' });
  });

  // The important ones. A request that did not succeed is NOT evidence that a
  // number is right, and counting it as a pass once hid a real renumbering.
  it('never turns a rate limit into a pass', async () => {
    respond({ ok: false, status: 429, url: 'x' });
    // retryPauseMs kept at 0 so the suite does not wait out the real backoff.
    expect(await askForum(proposal, { retryPauseMs: 0 })).toEqual({
      kind: 'unchecked',
      why: 'rate limited (429)',
    });
  });

  // Separate from unchecked: a deleted topic will still be deleted next run.
  it('reports a topic that does not exist instead of asking again later', async () => {
    respond({ ok: false, status: 404, url: 'x' });
    expect(await askForum(proposal)).toEqual({ kind: 'missing', why: 'HTTP 404' });
  });

  it('never turns an HTTP error into a pass', async () => {
    respond({ ok: false, status: 500, url: 'x' });
    expect(await askForum(proposal)).toMatchObject({ kind: 'unchecked', why: 'HTTP 500' });
  });

  it('never turns a network failure into a pass', async () => {
    respond(new Error('socket hang up'));
    expect(await askForum(proposal)).toMatchObject({ kind: 'unchecked', why: 'socket hang up' });
  });

  it('waits for the interval the forum asked for, then retries', async () => {
    const fetchMock = respondInTurn(
      { ok: false, status: 429, url: 'x', headers: new Headers({ 'retry-after': '0' }) },
      { ok: true, status: 200, url: 'https://x/t/erc-8400-title/1' },
    );
    expect(await askForum(proposal)).toEqual({ kind: 'match' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Holding the run open for ten minutes helps nobody; report the reset time.
  it('gives up at once when the reset window is longer than the cap', async () => {
    const fetchMock = respondInTurn({
      ok: false,
      status: 429,
      url: 'x',
      headers: new Headers({ 'retry-after': '600' }),
    });
    const outcome = await askForum(proposal);
    expect(outcome.kind).toBe('unchecked');
    expect((outcome as { why: string }).why).toContain('600s');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retryDelayMs', () => {
  const withHeader = (v?: string) =>
    stub({ headers: new Headers(v === undefined ? {} : { 'retry-after': v }) });

  it('honors a reset time within the cap', () => {
    expect(retryDelayMs(withHeader('3'), 4000)).toBe(3000);
  });

  it('refuses to wait out a reset time beyond the cap', () => {
    expect(retryDelayMs(withHeader('999'), 4000)).toBeNull();
  });

  it('falls back when the server says nothing usable', () => {
    expect(retryDelayMs(withHeader(), 4000)).toBe(4000);
    expect(retryDelayMs(withHeader('soon'), 4000)).toBe(4000);
  });
});

describe('the forum-confirmation cache', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cacheOf = (n: number, at: number) => ({
    version: 1,
    entries: { [proposal.disc]: { n, at } },
  });

  it('round-trips a confirmed match through a file it creates', async () => {
    await withTemporaryDir(async (dir) => {
      const file = path.join(dir, 'nested', 'review-forum.json');
      await saveReviewCache(file, cacheOf(8400, 1000));

      const loaded = await loadReviewCache(file);
      expect(loaded.entries[proposal.disc]).toEqual({ n: 8400, at: 1000 });
      expect(cacheHit(loaded, proposal, 1000)).toBe(true);
    });
  });

  it('stops trusting a confirmation once it is a day old', () => {
    expect(cacheHit(cacheOf(8400, 1000), proposal, 1000 + DAY_MS)).toBe(false);
  });

  // The URL can stay put while our file renumbers the proposal under it.
  it('stops trusting a confirmation when the number changed', () => {
    expect(cacheHit(cacheOf(8351, 1000), proposal, 1000)).toBe(false);
  });

  it('starts empty rather than guessing when the file is unusable', async () => {
    await withTemporaryDir(async (dir) => {
      expect(await loadReviewCache(path.join(dir, 'absent.json'))).toEqual({
        version: 1,
        entries: {},
      });

      const older = path.join(dir, 'older.json');
      await writeFile(older, JSON.stringify({ version: 0, entries: cacheOf(8400, 1000).entries }));
      expect(await loadReviewCache(older)).toEqual({ version: 1, entries: {} });
    });
  });
});

async function withTemporaryDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eipeek-review-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('classifyDiscussion', () => {
  // These used to be dropped by the filter, which made them look like passes.
  it('rejects values that are not URLs at all', () => {
    expect(classifyDiscussion('TBD')).toBe('not a URL');
    expect(classifyDiscussion('self')).toBe('not a URL');
    expect(classifyDiscussion('')).toBe('not a URL');
    expect(classifyDiscussion(undefined)).toBe('not a URL');
  });

  it('rejects URLs that are not Magicians topics', () => {
    expect(classifyDiscussion('https://github.com/ethereum/ERCs/issues/1234')).toBe(
      'not an ethereum-magicians topic',
    );
    expect(classifyDiscussion('https://ethresear.ch/t/some-thread/9999')).toBe(
      'not an ethereum-magicians topic',
    );
  });

  // Real case: ERC-8156 points at a topic path ending in /TBD.
  it('rejects a topic whose id is not a number', () => {
    expect(classifyDiscussion('https://ethereum-magicians.org/t/agent-onchain-metadata/TBD')).toBe(
      'topic id "TBD" is not numeric',
    );
  });

  // Real case: ERC-8155 uses 99999.
  it('rejects obviously invented topic ids', () => {
    expect(classifyDiscussion('https://ethereum-magicians.org/t/x/99999')).toBe(
      'placeholder topic id 99999',
    );
    expect(classifyDiscussion('https://ethereum-magicians.org/t/x/0')).toBe(
      'placeholder topic id 0',
    );
    expect(classifyDiscussion('https://ethereum-magicians.org/t/x/12345')).toBe(
      'placeholder topic id 12345',
    );
  });

  it('accepts a real topic URL', () => {
    expect(classifyDiscussion('https://ethereum-magicians.org/t/erc-1954-foo/29400')).toBeNull();
  });
});
