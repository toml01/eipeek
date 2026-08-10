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
   * Match bare numbers with no EIP/ERC prefix. Off by default: 34 proposal
   * numbers are plausible years (2015, 2020, 2025, 2026...) and 91 are under
   * 1000, so unguarded bare matching lights up ordinary prose.
   */
  bareNumbers: boolean;
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
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  bareNumbers: false,
  includeUnmerged: true,
  lookupOnSelection: true,
  debugMode: false,
  highlightStyle: 'underline',
  // Nothing disabled. The canonical sites were pre-disabled here, on the
  // grounds that they link every reference already -- but a link still shows
  // only the number, and the title and status are what the tooltip adds.
  disabledSites: [],
};
