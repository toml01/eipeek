/** A proposal record as stored in data/eips.json (short keys keep it small). */
export interface Proposal {
  n: number;
  t: string;
  d: string;
  s: string;
  ty: string;
  c: string;
  k: 'eip' | 'erc';
  disc: string;
  cr: string;
  req: number[];

  // -- present only on proposals that live in an open pull request ----------
  /** PR number; its absence is what marks a proposal as merged. */
  pr?: number;
  prRepo?: 'EIPs' | 'ERCs';
  /** Head commit, so the source link is stable. */
  prRef?: string;
  /** Head repo (usually a fork), needed for the source link. */
  prHead?: string;
  /** PR creation time; decides display order among rival claims. */
  prOpened?: string;
  /**
   * The number in the PR's filename, when it differs from the canonical `n`.
   * PR #12081 still ships eip-8361.md even though the proposal is now EIP-8363,
   * so the source link has to use this rather than `n`.
   */
  prFileN?: number;

  /**
   * Numbers still used for this proposal in the wild, from data/aliases.json.
   * `n` is what an editor assigned; these are what people write anyway, and both
   * have to resolve.
   */
  aka?: number[];
}

export function isUnmerged(p: Proposal): boolean {
  return p.pr !== undefined;
}

/** A reference found in page text, before metadata is attached. */
export interface Match {
  /** Character offset of the match within the text it was found in. */
  start: number;
  end: number;
  /** The resolved proposal number. */
  n: number;
  /** The exact text that matched, e.g. "EIP-7702" or "7702". */
  text: string;
  /**
   * The prefix as written by the author, if any. Used to detect the
   * EIP/ERC mix-up case -- someone writing "EIP-4337" for what is
   * canonically ERC-4337.
   */
  writtenKind: 'eip' | 'erc' | null;
}

export interface Settings {
  enabled: boolean;
  /**
   * Match bare numbers with no EIP/ERC prefix, unrestricted: any 1-5 digit
   * number that is a real proposal. Off by default, and that default is what
   * makes the looseness affordable -- 34 proposal numbers are plausible years
   * and 8 are single digits, so "I have 3 apples" marks the 3. Someone who turns
   * this on is asking for every candidate.
   */
  bareNumbers: boolean;
  /**
   * Alpha. Narrows `bareNumbers` back down to numbers that look like proposals
   * *in context*: 4-5 digits, no year or currency or date shape, and a block of
   * text that holds a prefixed reference or two Ethereum terms. Meaningless
   * unless `bareNumbers` is on. Off by default, so the plain setting stays
   * predictable and this stays the thing you opt into.
   */
  predictEthBlocks: boolean;
  /**
   * Resolve proposals that so far exist only in an open pull request. On by
   * default: numbers are assigned at PR-open time and discussion clusters in
   * that window, so these are often the most-referenced proposals of all.
   */
  includeUnmerged: boolean;
  /**
   * Look up a number the user selects, skipping every context heuristic. An
   * explicit selection is better evidence that a number is a reference than any
   * heuristic could be, so this is how you reach a bare number on a page the
   * automatic rules will not touch.
   */
  lookupOnSelection: boolean;
  /**
   * Show a card explaining why a selected number did not resolve, instead of
   * staying silent. A diagnostic, not a feature -- without it a miss is
   * indistinguishable from the extension being broken.
   */
  debugMode: boolean;
  highlightStyle: 'underline' | 'background' | 'both';
  /** Hostnames the user has switched off. */
  disabledSites: string[];
  /**
   * Hostnames where bare numbers are never matched, while prefixed references
   * still are. Not `disabledSites`: the site where unrestricted matching gets
   * noisy -- a sports table, an issue tracker -- is usually still a site where
   * an explicit `EIP-7702` is worth a tooltip.
   */
  bareNumberBlockedSites: string[];
  /**
   * Most matches to paint on one page. 0 removes the limit.
   *
   * A limit exists because unrestricted Tier 2 is density-bound, not
   * length-bound: a number-heavy table with no Ethereum content at all -- the
   * all-time Olympic medal table -- yields 2262 candidates. Truncation is
   * document-order, so the tail of such a page gets nothing.
   */
  maxMatches: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  bareNumbers: false,
  predictEthBlocks: false,
  includeUnmerged: true,
  lookupOnSelection: true,
  debugMode: false,
  highlightStyle: 'underline',
  // Nothing disabled. The canonical sites were pre-disabled here, on the
  // grounds that they link every reference already -- but a link still shows
  // only the number, and the title and status are what the tooltip adds.
  disabledSites: [],
  bareNumberBlockedSites: [],
  maxMatches: 2000,
};
