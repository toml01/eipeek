/**
 * Finding EIP/ERC references in plain text.
 *
 * Pure string functions -- no DOM -- so the tricky parts are unit-testable.
 *
 * Two tiers:
 *   Tier 1  explicit prefix ("EIP-7702", "ERC 20", "EIPs 3074 and 7702").
 *           Unambiguous, always on.
 *   Tier 2  bare numbers ("7702"). Opt-in, off by default, and once on it is
 *           unrestricted: any 1-5 digit number that resolves to a proposal is
 *           marked. That lights up ordinary prose -- 34 proposals are plausible
 *           years, 8 are single digits -- which is an accepted cost, because a
 *           setting nobody has switched on cannot mislead anyone.
 *
 *           The one thing that survives unconditionally is the *structural*
 *           reading of the digits (`bareIsWholeNumber`): "7702" inside "77021"
 *           or "1,7702" is not the number 7702 at all, so matching it would
 *           highlight a number the text does not contain.
 *
 *           The `predictEthBlocks` alpha setting restores the old restrictions:
 *           a 4-digit floor, the meaning filters in `bareLooksLikeProposal`, and
 *           the per-block context gate `blockAllowsBare`.
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

/**
 * Bare number candidate: 1-5 digits, since proposals run from 1 to five figures.
 *
 * The word boundaries are load-bearing rather than cosmetic, and they are the
 * reason no separate "is this hex?" rule is needed: `0x7702`, `v7702`, `77021x`
 * and `1234567702` have a word character butting against the digits, so the
 * boundary never holds and the candidate never appears. A 6+ digit run is
 * likewise unmatchable -- `\d{1,5}` can never reach both of its ends.
 */
const BARE = /\b(\d{1,5})\b/g;

/** Digit floor under `predictEthBlocks`; excluding <=999 removes the noisiest 91. */
const BARE_STRICT_MIN_DIGITS = 4;

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

/*
 * There is deliberately no host allowlist. One existed to unlock bare numbers on
 * eips.ethereum.org and the research forums without needing evidence from the
 * text, but with bare matching unrestricted by default it grants nothing, and
 * under `predictEthBlocks` it would be the one page-wide hole in a gate whose
 * whole point is being block-local. Sites the user wants excluded are named
 * instead, via `bareNumberBlockedSites`.
 */

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
 * Whether one block of text has earned bare-number matching under
 * `predictEthBlocks`. Unused when that setting is off, which is the default.
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
   * Enables Tier 2 for this text. The caller composes it, since only the caller
   * knows the hostname and the settings: the `bareNumbers` setting, minus the
   * `bareNumberBlockedSites` blacklist, and under `strictBare` also
   * `blockAllowsBare(text)`.
   */
  allowBare?: boolean;
  /**
   * The `predictEthBlocks` alpha mode, as it applies to a single run of text: a
   * 4-digit floor plus the meaning filters in `bareLooksLikeProposal`. The third
   * part of that mode, the per-block gate, cannot live here -- it decides whether
   * Tier 2 runs at all, so it arrives folded into `allowBare`.
   */
  strictBare?: boolean;
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
      const digits = m[1]!;
      const n = Number(digits);
      const start = m.index;
      const end = start + digits.length;
      // Cheapest rejections first, and the ones that reject the most: this loop
      // now visits every number on the page, not just the 4-5 digit ones, and
      // almost none of them are proposals.
      if (opts.strictBare && digits.length < BARE_STRICT_MIN_DIGITS) continue;
      if (!opts.isValid(n)) continue;
      if (isClaimed(start, end)) continue;
      const ok = opts.strictBare
        ? bareLooksLikeProposal(text, start, end)
        : bareIsWholeNumber(text, start, end);
      if (!ok) continue;
      matches.push({ start, end, n, text: digits, writtenKind: null });
      claim(start, end);
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Whether the digits at [start, end) are a whole number, rather than one piece
 * of a longer numeric literal.
 *
 * This is the only bare-number check that applies unconditionally, because it is
 * not a guess about what the number means -- it decides *which number the text
 * holds*. "7702" inside "1,7702" is the thousands group of 17702 and "7702" in
 * "7702.5" is the integer part of 7702.5, so marking either would put a
 * highlight on a number nobody wrote. A digit run that is merely adjacent to
 * word characters ("0x7702", "77021") never reaches here at all: `BARE` requires
 * word boundaries on both sides.
 *
 * Only "." and "," count as joiners, since only they fuse two digit runs into
 * one value. A hyphen or a slash does not: in "7702-7710" and "2024/7702" both
 * numbers are complete, and calling them a range or a date is a claim about
 * meaning, which belongs in `bareLooksLikeProposal`.
 */
export function bareIsWholeNumber(text: string, start: number, end: number): boolean {
  // Two characters is all the context this needs, so the window is tiny.
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 2);
  if (/\d[.,]$/.test(before)) return false;
  if (/^[.,]\d/.test(after)) return false;
  return true;
}

/**
 * Rejects bare numbers whose surroundings say "this is a year, an amount, a
 * date, or an identifier" rather than "this is a proposal".
 *
 * Only used under `predictEthBlocks`. Every rule here is a judgement about
 * meaning, and each one costs real references: this is what refuses "pre-7702
 * behaviour", "$7702" in a post about grant sizes, and the proposals numbered
 * 2015 and 2025 outright.
 */
export function bareLooksLikeProposal(text: string, start: number, end: number): boolean {
  if (!bareIsWholeNumber(text, start, end)) return false;

  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 24);

  // Hyphenated numeric range, which for 4-digit numbers is nearly always years
  // or a numeric span: "2024 - 2026", "7702 - 7710".
  if (/[\d]\s*[-–—]\s*$/.test(before)) return false;
  if (/^\s*[-–—]\s*[\d]{4}\b/.test(after)) return false;
  // Hyphen-joined identifier or slug: "build-7702-rc1", "v2-7702", "7702-rc1".
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
 * Deliberately skips every gate that automatic matching applies -- the
 * `bareNumbers` setting itself, the site blacklist, and under `predictEthBlocks`
 * the digit floor, the meaning filters and the block gate. Selecting a number is
 * the user asserting it is a reference, which is better evidence than any
 * heuristic, so `20` and `2025` resolve here even on a page where nothing is
 * matched automatically.
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
