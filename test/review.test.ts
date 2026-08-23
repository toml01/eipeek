import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForum, classifyDiscussion, type Proposal } from '../scripts/review-dataset';

const proposal = { n: 8400, t: 'x', k: 'erc', disc: 'https://example.test/t/x/1' } as Proposal;

const respond = (r: Partial<Response> | Error) =>
  vi.stubGlobal('fetch', async () => {
    if (r instanceof Error) throw r;
    return r as Response;
  });

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
});

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
