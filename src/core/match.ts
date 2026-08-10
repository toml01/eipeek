/**
 * Finding EIP/ERC references in plain text.
 *
 * Pure string functions -- no DOM -- so the tricky parts are unit-testable.
 *
 * Two tiers:
 *   Tier 1  explicit prefix ("EIP-7702", "ERC 20", "EIPs 3074 and 7702").
 *           Unambiguous, always on.
 *   Tier 2  bare numbers ("7702"). Opt-in and heavily gated, because the
 *           number space overlaps ordinary prose badly: 34 proposals are
 *           plausible years (including 2015, 2019-2021, 2025, 2026) and 91
 *           are under 1000 (1, 2, 20, 100, 150, 999...). Its context gate is
 *           per block of text (`blockAllowsBare`), not per page -- a feed is
 *           one page holding many unrelated blocks.
 */
import type { Match } from './types';

/**
 * Prefixed reference. Notes on the pieces:
 *   \b(eip|erc)s?   - the optional plural matters; "EIPs 3074" and "ERCs" are
 *                     common in prose, and without it the prefix is missed.
 *   [\s]*[-–—_:]?[\s]*
 *                   - covers "EIP-7702", "EIP 7702", "EIP7702", "EIP - 7702".
 *                     Deliberately excludes "." so that a sentence boundary
 *                     ("...the EIP. 7702 is...") is not read as a reference.
 *   (\d{1,5})s?\b   - the optional trailing plural lets "ERC-721s" match.
 */
const PREFIXED = /\b(eip|erc)s?[ \t]*[-–—_:]?[ \t]*(\d{1,5})s?\b/gi;

/**
 * Continuation of a prefixed list: the "and 7702" in "EIPs 3074 and 7702".
 * Anchored to a Tier 1 match, so it inherits that match's certainty.
 *
 * Continuations require >=3 digits. Without that, "EIP-20 and 5 others" would
 * pick up 5 (a real EIP) from an ordinary quantity.
 */
const CONTINUATION = /^([ \t]*(?:,|and|&|\/|\+)[ \t]*)(\d{3,5})s?\b/i;

/** Bare number: 4-5 digits only. Excluding <=999 removes the noisiest 91. */
const BARE = /\b(\d{4,5})\b/g;

/** Words that mark a following 4-digit number as a year rather than a proposal. */
const YEAR_LEAD =
  /(?:^|[\s(])(?:in|since|by|during|until|till|through|after|before|from|circa|c\.|ca\.|around|about|early|mid|late|spring|summer|autumn|fall|winter|q[1-4]|fy|©|copyright|version|ver|v)[\s.]*$/i;

const MONTHS =
  /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,]*$/i;

/** Currency symbols and unit words that mark a number as an amount. */
const CURRENCY_LEAD = /[$€£¥₪]\s*$/;
/** Kept separate from the word units below: \b does not apply after "%". */
const PERCENT_TRAIL = /^\s*%/;
const UNIT_TRAIL =
  /^\s*(?:usd|eur|gbp|eth|btc|wei|gwei|szabo|finney|tokens?|coins?|nft|px|em|rem|ms|kb|mb|gb|tb|bytes?|blocks?|txs?|users?|people|times|years?|months?|days?|hours?|min(?:ute)?s?|sec(?:ond)?s?)\b/i;

const HOSTS = [
  'eips.ethereum.org',
  'ercs.ethereum.org',
  'ethereum-magicians.org',
  'ethresear.ch',
  'ethereum.org',
  'blog.ethereum.org',
  'notes.ethereum.org',
  'hackmd.io',
  'forum.openzeppelin.com',
  'ethereum.stackexchange.com',
];

/**
 * Site-level trust: hosts where a proposal number is the dominant meaning of a
 * 4-digit number, so bare matching needs no evidence from the text itself.
 * Deliberately the only page-wide part of the Tier 2 gate.
 */
export function isEthHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

/**
 * Ethereum vocabulary, used to judge one block of text on its own. Listed
 * singular; the regex allows a trailing plural, so "rollups" and "transactions"
 * count without a second entry.
 */
const ETH_TERMS = [
  'eip', 'erc', 'rip', 'ethereum', 'eth', 'evm', 'opcode', 'precompile',
  'rollup', 'l1', 'l2', 'mainnet', 'testnet', 'hardfork', 'fork', 'upgrade',
  'proposal', 'spec', 'gas', 'calldata', 'blob', 'stark', 'snark', 'zk',
  'validator', 'staking', 'consensus', 'mempool', 'nonce', 'eoa', 'solidity',
  'abi', 'devnet', 'beacon', 'slot', 'epoch', 'tx', 'transaction', 'account',
  'abstraction', 'bundler', 'paymaster', 'signature', 'semantics', 'registry',
  'glamsterdam', 'pectra', 'fusaka',
];

/** The capture group excludes the plural, so counting keys on the term itself. */
const ETH_TERM = new RegExp(`\\b(${ETH_TERMS.join('|')})s?\\b`, 'gi');

/**
 * Distinct terms a block needs before a bare number is plausible in it.
 *
 * Two, because one is reachable by coincidence -- "fork" in a recipe, "account"
 * in a bank statement -- while two separates cleanly in practice: "gas limit
 * bump to 8141 in the next fork" scores 2, and prose that merely contains
 * 4-digit numbers ("returns 8141 records per page", "raised 8141 million in
 * funding", "the RTX 4090 beats the 3080") scores 0.
 */
const ETH_TERM_MIN = 2;

/** Non-global copy, so `test` carries no lastIndex state. */
const HAS_PREFIX = new RegExp(PREFIXED.source, 'i');

/** Distinct Ethereum terms in a block of text, plurals folded into the singular. */
export function countEthTerms(text: string): number {
  const seen = new Set<string>();
  ETH_TERM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ETH_TERM.exec(text)) !== null) seen.add(m[1]!.toLowerCase());
  return seen.size;
}

/**
 * Whether one block of text has earned bare-number matching.
 *
 * Per block rather than per page, because a page-wide signal is wrong in both
 * directions on a feed: one post mentioning EIP-7702 would unlock every
 * unrelated post beside it, while a post writing only bare numbers would never
 * unlock at all.
 *
 * Evidence is either an explicit prefixed reference in the same block, or
 * enough Ethereum vocabulary that a 4-5 digit number is likelier a proposal
 * than a year, a port, or a quantity. Terse blocks lose out -- "thoughts on
 * 8141?" scores 0 -- which is what the selection lookup exists for.
 */
export function blockAllowsBare(text: string): boolean {
  return HAS_PREFIX.test(text) || countEthTerms(text) >= ETH_TERM_MIN;
}

export interface FindOptions {
  /** Rejects any number not in the dataset. */
  isValid: (n: number) => boolean;
  /**
   * Enables Tier 2 for this text. Requires the user setting plus either a
   * trusted host (`isEthHost`) or block-local evidence (`blockAllowsBare`);
   * the caller composes those, since only it knows the hostname.
   */
  allowBare?: boolean;
}

/** Finds all references in a single run of text, ordered and non-overlapping. */
export function findMatches(text: string, opts: FindOptions): Match[] {
  const matches: Match[] = [];
  const claimed: Array<[number, number]> = [];

  const claim = (start: number, end: number) => {
    claimed.push([start, end]);
  };
  const isClaimed = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  // -- Tier 1 -------------------------------------------------------------
  PREFIXED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PREFIXED.exec(text)) !== null) {
    const kind = m[1]!.toLowerCase() as 'eip' | 'erc';
    const n = Number(m[2]);
    // The matched slice may include a trailing plural "s" that is not part of
    // the number; trim back to the last digit so the highlight ends cleanly.
    const digitsEnd = m.index + m[0].replace(/s$/i, '').length;

    if (!opts.isValid(n)) continue;
    matches.push({
      start: m.index,
      end: digitsEnd,
      n,
      text: text.slice(m.index, digitsEnd),
      writtenKind: kind,
    });
    claim(m.index, digitsEnd);

    // Walk any "and 7702, 3074" tail that follows.
    let cursor = digitsEnd;
    for (;;) {
      const tail = CONTINUATION.exec(text.slice(cursor));
      if (!tail) break;
      const num = Number(tail[2]);
      const numStart = cursor + tail[1]!.length;
      const numEnd = numStart + tail[2]!.length;
      if (!opts.isValid(num)) break;
      matches.push({
        start: numStart,
        end: numEnd,
        n: num,
        text: text.slice(numStart, numEnd),
        // Written bare, but licensed by the prefix that introduced the list.
        writtenKind: kind,
      });
      claim(numStart, numEnd);
      cursor = numEnd;
    }
    PREFIXED.lastIndex = Math.max(PREFIXED.lastIndex, cursor);
  }

  // -- Tier 2 -------------------------------------------------------------
  if (opts.allowBare) {
    BARE.lastIndex = 0;
    while ((m = BARE.exec(text)) !== null) {
      const n = Number(m[1]);
      const start = m.index;
      const end = start + m[1]!.length;
      if (isClaimed(start, end)) continue;
      if (!opts.isValid(n)) continue;
      if (!bareLooksLikeProposal(text, start, end)) continue;
      matches.push({ start, end, n, text: m[1]!, writtenKind: null });
      claim(start, end);
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Rejects bare numbers whose surroundings say "this is a year, an amount, or
 * part of a larger number" rather than "this is a proposal".
 */
export function bareLooksLikeProposal(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 24);

  // Part of a larger number: "1,7702", "3.7702", "7702.5", "12,7702,1".
  if (/[\d][.,]$/.test(before)) return false;
  if (/^[.,][\d]/.test(after)) return false;
  // Hyphenated numeric range, which for 4-digit numbers is nearly always years
  // or a numeric span: "2024 - 2026", "7702 - 7710".
  if (/[\d]\s*[-–—]\s*$/.test(before)) return false;
  if (/^\s*[-–—]\s*[\d]{4}\b/.test(after)) return false;
  // Hyphen-joined identifier or slug: "build-7702-rc1", "v2-7702", "7702-rc1".
  // This also rejects prose like "pre-7702 behaviour", which is a genuine
  // reference -- but Tier 2 is opt-in, so under-matching is the safer error.
  if (/[A-Za-z0-9]-$/.test(before)) return false;
  if (/^-[A-Za-z0-9]/.test(after)) return false;
  // Date shapes: "2024/05/07", "05/2024".
  if (/[\d]\s*\/\s*$/.test(before)) return false;
  if (/^\s*\/\s*[\d]/.test(after)) return false;

  if (CURRENCY_LEAD.test(before)) return false;
  if (PERCENT_TRAIL.test(after)) return false;
  if (UNIT_TRAIL.test(after)) return false;
  if (MONTHS.test(before)) return false;
  if (YEAR_LEAD.test(before)) return false;

  // A bare 19xx/20xx with nothing marking it as a proposal is far more likely
  // a year. Require an explicit prefix for those.
  const n = Number(text.slice(start, end));
  if (n >= 1900 && n <= 2100) return false;

  return true;
}

/**
 * A whole selection that is nothing but a reference.
 *
 * Anchored at both ends on purpose: that anchoring *is* the "the selection is
 * only a token" rule, and it is why selecting a sentence can never trigger a
 * lookup. Accepts the forms people actually select -- `8141`, `EIP-8141`,
 * `eip 8141`, `ERC20`, `#8141` -- including the non-breaking hyphen that copying
 * from rendered pages sometimes produces.
 */
const SELECTION = /^(?:(eip|erc)s?[\s\-–—‑_:.]*)?#?[\s]*(\d{1,5})$/i;

/**
 * Parses an explicit user selection into a reference.
 *
 * Deliberately skips every heuristic `findMatches` applies to bare numbers --
 * the digit floor, the year and currency and hex rejections, the page-level
 * Ethereum-context gate. Selecting a number is the user asserting it is a
 * reference, which is better evidence than any heuristic. So `20` and `2025`
 * resolve here even though automatic matching will never claim them.
 *
 * Returns null when the selection is not purely a reference; the caller decides
 * whether the number actually exists.
 */
export function parseSelection(text: string): Match | null {
  const trimmed = text.trim();
  const m = SELECTION.exec(trimmed);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return {
    start: 0,
    end: trimmed.length,
    n,
    text: trimmed,
    writtenKind: m[1] ? (m[1].toLowerCase() as 'eip' | 'erc') : null,
  };
}

/**
 * Canonical display label. Because EIPs and ERCs share one number space, a
 * number identifies exactly one proposal -- so someone writing "EIP-4337" for
 * what is canonically ERC-4337 is referring to the right thing by the wrong
 * name. Worth showing gently rather than treating as a miss.
 */
export function canonicalLabel(n: number, kind: 'eip' | 'erc'): string {
  return `${kind.toUpperCase()}-${n}`;
}

export function isKindMismatch(match: Match, actual: 'eip' | 'erc'): boolean {
  return match.writtenKind !== null && match.writtenKind !== actual;
}
