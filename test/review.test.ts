import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForum, type Proposal } from '../scripts/review-dataset';

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

  it('never turns an HTTP error into a pass', async () => {
    respond({ ok: false, status: 500, url: 'x' });
    expect(await askForum(proposal)).toMatchObject({ kind: 'unchecked', why: 'HTTP 500' });
  });

  it('never turns a network failure into a pass', async () => {
    respond(new Error('socket hang up'));
    expect(await askForum(proposal)).toMatchObject({ kind: 'unchecked', why: 'socket hang up' });
  });
});
