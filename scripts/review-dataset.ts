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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Deliberately slow. A concurrent sweep gets HTTP 429 from the forum, and a
 *  rate-limited request that is counted as a pass is worse than no check at all. */
const CONCURRENCY = 2;
const DELAY_MS = 250;
const RETRY_PAUSE_MS = 4000;

/** Mirrors the maintenance skill's retry policy: honor a server reset time only
 *  up to 120 s, and otherwise stop and report it rather than hold the run open. */
const MAX_RETRY_AFTER_MS = 120_000;

const CACHE_FILE = path.join(ROOT, '.cache', 'review-forum.json');

/** A day, so retries minutes apart resume instead of re-asking ~200 topics, while
 *  the roughly weekly run still re-verifies every match -- a stale match turning
 *  into a disagreement is the renumbering signal this tool exists to catch. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/**
 * How long to wait before retrying a rate-limited request, or null when the server
 * asked for longer than the cap. Null means "do not wait": a run that sleeps for
 * the forum's whole reset window is a run nobody waits for, so the caller reports
 * the reset time instead.
 */
export function retryDelayMs(
  res: Response,
  fallbackMs: number,
  capMs = MAX_RETRY_AFTER_MS,
): number | null {
  const raw = res.headers.get('retry-after')?.trim();
  const seconds = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) return fallbackMs;
  const ms = seconds * 1000;
  return ms <= capMs ? ms : null;
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
        const wait = retryDelayMs(res, retryPauseMs);
        if (wait === null) {
          const after = res.headers.get('retry-after')?.trim();
          return {
            kind: 'unchecked',
            why:
              `rate limited (429), Retry-After ${after}s ` +
              `exceeds ${MAX_RETRY_AFTER_MS / 1000}s cap`,
          };
        }
        await sleep(wait);
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

export interface ReviewCache {
  version: number;
  entries: Record<string, { n: number; at: number }>;
}

const EMPTY_CACHE = (): ReviewCache => ({ version: 1, entries: {} });

/** A cache is an optimisation, never evidence, so anything unreadable or written
 *  by an older format is discarded rather than repaired. */
export async function loadReviewCache(file: string): Promise<ReviewCache> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ReviewCache;
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return EMPTY_CACHE();
    }
    return parsed;
  } catch {
    return EMPTY_CACHE();
  }
}

export async function saveReviewCache(file: string, cache: ReviewCache) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

/** Keyed on the discussion URL, but the number is checked too: our file can
 *  renumber a proposal under a URL that never changes, and skipping that case is
 *  exactly the failure this tool exists to prevent. */
export function cacheHit(cache: ReviewCache, p: Proposal, now = Date.now()): boolean {
  const entry = cache.entries[p.disc];
  return entry !== undefined && entry.n === p.n && now - entry.at < CACHE_TTL_MS;
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

  const noCache = process.argv.includes('--no-cache');
  const cache = noCache ? EMPTY_CACHE() : await loadReviewCache(CACHE_FILE);
  const now = Date.now();
  const cached = toCheck.filter((p) => cacheHit(cache, p, now));
  const cachedSet = new Set(cached);
  const toFetch = toCheck.filter((p) => !cachedSet.has(p));

  log(`Asking the forum about ${toFetch.length} open-PR proposals.`);
  log(`Throttled to ${CONCURRENCY} at a time, so this takes a while.`);
  if (cached.length) {
    log(
      `${cached.length} confirmed within the last 24 h skipped ` +
        '(.cache/review-forum.json; --no-cache re-checks all).',
    );
  }
  if (placeholders.length) {
    log(`${placeholders.length} have unusable discussion URLs; reported below, not fetched.`);
  }
  log();

  const results = await mapLimit(toFetch, CONCURRENCY, async (p) => ({
    p,
    outcome: await askForum(p),
  }));

  const disagrees = results.filter((r) => r.outcome.kind === 'disagrees');
  const noNumber = results.filter((r) => r.outcome.kind === 'no-number');
  const missing = results.filter((r) => r.outcome.kind === 'missing');
  const unchecked = results.filter((r) => r.outcome.kind === 'unchecked');
  const matched = results.filter((r) => r.outcome.kind === 'match').length + cached.length;

  // Rebuilt from scratch so that only this run's matches survive: a disagreement,
  // a failure or a vanished topic must be re-examined next time, never inherited.
  const rebuilt = EMPTY_CACHE();
  // Carried-over hits keep their original timestamp, so repeated retries cannot
  // roll the day forward forever and stop the weekly re-verification.
  for (const p of cached) rebuilt.entries[p.disc] = { n: p.n, at: cache.entries[p.disc]!.at };
  for (const { p, outcome } of results) {
    if (outcome.kind === 'match') rebuilt.entries[p.disc] = { n: p.n, at: now };
  }
  await saveReviewCache(CACHE_FILE, rebuilt);

  log(`${matched} agree with the forum${cached.length ? ` (${cached.length} from cache)` : ''}.`);
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
