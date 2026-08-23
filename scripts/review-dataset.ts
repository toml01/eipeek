/**
 * Asks the forum whether any open-PR proposal has been renumbered.
 *
 * Run with `npm run data:review`. Reads the committed data/eips.json; it does not
 * re-download the repos, so it is much cheaper than `npm run data:build`.
 *
 * How it works: Discourse keys a thread on its trailing topic id and rewrites the
 * slug when the title changes, so following a `discussions-to` URL reveals the
 * number the forum currently uses. Both renumberings found so far showed up this
 * way -- erc-8338-... redirects to erc-8351-..., and eip-8361-... to eip-8363-...
 *
 * Advisory only. It exits 0 whatever it finds, because upstream churn must never
 * break a build, and because it produces false positives: a `discussions-to`
 * pointing at the wrong thread will report a disagreement that is not one.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Deliberately slow. A concurrent sweep gets HTTP 429 from the forum, and a
 *  rate-limited request that is counted as a pass is worse than no check at all. */
const CONCURRENCY = 2;
const DELAY_MS = 250;
const RETRY_PAUSE_MS = 4000;

export interface Proposal {
  n: number;
  t: string;
  k: 'eip' | 'erc';
  disc: string;
  pr?: number;
  prRepo?: 'EIPs' | 'ERCs';
  aka?: number[];
}

interface AliasEntry {
  canonical: number;
  target: { pr?: number; repo?: string; n?: number };
}

export type Outcome =
  | { kind: 'match' }
  | { kind: 'disagrees'; forum: number; final: string }
  | { kind: 'no-number'; final: string }
  | { kind: 'placeholder'; why: string }
  | { kind: 'missing'; why: string }
  | { kind: 'unchecked'; why: string };

/** True for topic ids no Discourse install ever issued: a filler the author typed
 *  because the thread did not exist yet. Fetching one only wastes a request. */
function isFakeTopicId(id: string): boolean {
  if (Number(id) === 0) return true;
  if (id.length >= 3 && /^(\d)\1*$/.test(id)) return true;
  const ascending = [...id].every((d, i, all) => i === 0 || Number(d) === Number(all[i - 1]) + 1);
  return id.length >= 5 && ascending;
}

/**
 * Says why a `discussions-to` URL cannot answer the renumbering question, or null
 * when it can. The old filter dropped every one of these silently, which read as a
 * pass; an unusable URL is a finding, not an absence of one.
 */
export function classifyDiscussion(disc: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(disc ?? '');
  } catch {
    return 'not a URL';
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const magicians = /(^|\.)ethereum-magicians\.org$/.test(url.hostname);
  if (!magicians || parts[0] !== 't' || parts.length < 2) {
    return 'not an ethereum-magicians topic';
  }

  // Discourse paths are /t/<slug>/<id>[/<post>], so the third segment is the topic
  // id even when the URL is a permalink to one post inside the thread.
  const id = parts[2] ?? parts[1]!;
  if (!/^\d+$/.test(id)) return `topic id ${JSON.stringify(id)} is not numeric`;
  if (isFakeTopicId(id)) return `placeholder topic id ${id}`;
  return null;
}

function log(msg = '') {
  process.stdout.write(`${msg}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
        await sleep(DELAY_MS);
      }
    }),
  );
  return out;
}

/** Follows the thread and reads the proposal number out of the final slug. */
export async function askForum(
  p: Proposal,
  { retryPauseMs = RETRY_PAUSE_MS } = {},
): Promise<Outcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(p.disc, { redirect: 'follow' });
    } catch (err) {
      return { kind: 'unchecked', why: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 429) {
      if (attempt === 0) {
        await sleep(retryPauseMs);
        continue;
      }
      return { kind: 'unchecked', why: 'rate limited (429)' };
    }
    // A topic that is gone stays gone, so this is a finding to fix upstream rather
    // than something a later rerun could resolve.
    if (res.status === 404 || res.status === 410) {
      return { kind: 'missing', why: `HTTP ${res.status}` };
    }
    if (!res.ok) return { kind: 'unchecked', why: `HTTP ${res.status}` };

    const m = /\/t\/(?:eip|erc|rip)-(\d+)-/.exec(res.url);
    if (!m) return { kind: 'no-number', final: res.url };
    const forum = Number(m[1]);
    return forum === p.n ? { kind: 'match' } : { kind: 'disagrees', forum, final: res.url };
  }
  return { kind: 'unchecked', why: 'rate limited (429)' };
}

async function main() {
  const proposals = JSON.parse(
    await readFile(path.join(ROOT, 'data', 'eips.json'), 'utf8'),
  ) as Proposal[];

  let aliases: AliasEntry[] = [];
  try {
    aliases = JSON.parse(await readFile(path.join(ROOT, 'data', 'aliases.json'), 'utf8'));
  } catch {
    // No alias file yet; nothing is covered.
  }
  const coveredPrs = new Set(aliases.map((a) => a.target.pr).filter(Boolean));

  // Only open-PR proposals can be renumbered, and anything already aliased is
  // settled. Candidates whose URL the forum cannot answer for are kept and named
  // below instead of being filtered out, because a silent drop reads as a pass.
  const candidates = proposals.filter((p) => p.pr !== undefined && !coveredPrs.has(p.pr));

  const placeholders: { p: Proposal; why: string }[] = [];
  const toCheck: Proposal[] = [];
  for (const p of candidates) {
    const why = classifyDiscussion(p.disc);
    if (why === null) toCheck.push(p);
    else placeholders.push({ p, why });
  }

  log(`Asking the forum about ${toCheck.length} open-PR proposals.`);
  log(`Throttled to ${CONCURRENCY} at a time, so this takes a while.`);
  if (placeholders.length) {
    log(`${placeholders.length} have unusable discussion URLs; reported below, not fetched.`);
  }
  log();

  const results = await mapLimit(toCheck, CONCURRENCY, async (p) => ({
    p,
    outcome: await askForum(p),
  }));

  const disagrees = results.filter((r) => r.outcome.kind === 'disagrees');
  const noNumber = results.filter((r) => r.outcome.kind === 'no-number');
  const missing = results.filter((r) => r.outcome.kind === 'missing');
  const unchecked = results.filter((r) => r.outcome.kind === 'unchecked');
  const matched = results.filter((r) => r.outcome.kind === 'match').length;

  log(`${matched} agree with the forum.`);
  log();

  if (disagrees.length) {
    // "Disagree" is all this can honestly claim. The forum is not automatically
    // right: a thread keeps whatever number its title was last edited to, so a
    // stale slug looks exactly like a renumbering. Two of the first three
    // disagreements found were stale threads, not renames.
    log(`${disagrees.length} disagree with the forum. Neither side is automatically right:`);
    for (const { p, outcome } of disagrees) {
      const o = outcome as Extract<Outcome, { kind: 'disagrees' }>;
      log(`\n  file says ${p.k}-${p.n}, forum says ${o.forum} -- ${JSON.stringify(p.t)}`);
      log(`    PR #${p.pr} ${p.prRepo}`);
      log(`    ${o.final}`);

      const owner = proposals.find((q) => q !== p && q.n === o.forum);
      if (owner) {
        log(
          `    LIKELY STALE THREAD: ${o.forum} already belongs to ` +
            `${JSON.stringify(owner.t)}${owner.pr ? ` (PR #${owner.pr})` : ' (merged)'}.`,
        );
      } else if (o.forum < p.n) {
        // Editors allocate from a queue, so a reassignment moves a number up.
        log(`    Forum number is lower, so the thread title is more likely stale than the file.`);
      } else {
        log(`    ${o.forum} is unclaimed. If the forum is right, add:`);
        log(
          `      { "canonical": ${o.forum}, "alsoKnownAs": [${p.n}], ` +
            `"target": { "pr": ${p.pr}, "repo": "${p.prRepo}" }, "reason": "..." }`,
        );
      }
    }
    log();
  }

  if (noNumber.length) {
    log(`${noNumber.length} thread titles carry no number, so the forum cannot say:`);
    for (const { p } of noNumber) log(`    ${p.k}-${p.n} PR #${p.pr}`);
    log();
  }

  if (placeholders.length) {
    log(
      `${placeholders.length} have discussion URLs this check cannot use. ` +
        'Deterministic; fix discussions-to upstream:',
    );
    for (const { p, why } of placeholders) {
      log(`    ${p.k}-${p.n} PR #${p.pr} -- ${why} -- ${p.disc}`);
    }
    log();
  }

  if (missing.length) {
    log(
      `${missing.length} point at forum topics that do not exist. ` +
        'Deterministic, not retry candidates:',
    );
    for (const { p, outcome } of missing) {
      log(`    ${p.k}-${p.n} PR #${p.pr} -- ${(outcome as { why: string }).why} -- ${p.disc}`);
    }
    log();
  }

  // Kept separate from the passes on purpose. A failed request is not evidence
  // that a number is correct, and folding the two together would make this tool
  // quietly useless -- a rate-limited sweep once hid the 8351 case completely.
  if (unchecked.length) {
    log(`${unchecked.length} COULD NOT BE CHECKED. These are not passes:`);
    for (const { p, outcome } of unchecked) {
      log(`    ${p.k}-${p.n} PR #${p.pr} -- ${(outcome as { why: string }).why}`);
    }
    log();
    log('Rerun later to check them.');
  }
}

// Guarded so a test can import askForum without firing 200 requests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    // Still exit 0: this is advisory and must not fail anyone's build.
    process.stderr.write(`review failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
