import { describe, expect, it } from 'vitest';
import {
  bareLooksLikeProposal,
  blockAllowsBare,
  countEthTerms,
  findMatches,
  isEthHost,
  parseSelection,
} from '../src/core/match';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../src/core/numbers.generated';

const valid = new Set(VALID_NUMBERS);
const isValid = (n: number) => valid.has(n);

const nums = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.n);

const texts = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.text);

describe('Tier 1 — prefixed references', () => {
  it.each([
    ['EIP-7702', 7702],
    ['eip-7702', 7702],
    ['EIP 7702', 7702],
    ['EIP7702', 7702],
    ['eip7702', 7702],
    ['EIP_7702', 7702],
    ['EIP:7702', 7702],
    ['EIP - 7702', 7702],
    ['EIP–7702', 7702], // en dash
    ['EIP—7702', 7702], // em dash
    ['ERC-20', 20],
    ['ERC20', 20],
    ['erc 20', 20],
    ['ERC-4337', 4337],
  ])('matches %j', (input, expected) => {
    expect(nums(input)).toEqual([expected]);
  });

  it('matches the plural prefix, which is common in prose', () => {
    // Without the optional "s" the prefix is missed entirely.
    expect(nums('EIPs 3074 introduced this')).toEqual([3074]);
    expect(nums('several ERCs 4337 style')).toContain(4337);
  });

  it('matches a trailing plural on the number', () => {
    expect(nums('ERC-721s are non-fungible')).toEqual([721]);
  });

  it('highlights only the reference, not a trailing plural', () => {
    expect(texts('ERC-721s')).toEqual(['ERC-721']);
  });

  it('finds several references in one run of text', () => {
    expect(nums('EIP-7702 builds on EIP-2718 and ERC-4337')).toEqual([7702, 2718, 4337]);
  });

  it('is case-insensitive and works mid-sentence', () => {
    expect(nums('see Eip-1559 for the fee market')).toEqual([1559]);
  });

  describe('rejections', () => {
    it('rejects numbers that are not real proposals', () => {
      expect(nums('EIP-99999')).toEqual([]);
      expect(nums('EIP-8888')).toEqual([]);
    });

    it('requires a word boundary before the prefix', () => {
      expect(nums('AEIP-7702')).toEqual([]);
      expect(nums('xeip7702')).toEqual([]);
    });

    it('does not match a prefix with no number', () => {
      expect(nums('the EIP- process')).toEqual([]);
      expect(nums('read the EIP')).toEqual([]);
    });

    it('does not read a sentence boundary as a separator', () => {
      // "." is deliberately excluded from the separator set.
      expect(nums('That is the EIP. 7702 comes later.')).toEqual([]);
    });

    it('does not match a number glued to trailing letters', () => {
      expect(nums('EIP-7702X')).toEqual([]);
    });
  });
});

describe('Tier 1 — list continuations', () => {
  it('follows "and", commas, and slashes after a prefixed reference', () => {
    expect(nums('EIPs 3074 and 7702')).toEqual([3074, 7702]);
    expect(nums('EIP-2718, 2930, 4844')).toEqual([2718, 2930, 4844]);
    expect(nums('EIP-7702/3074')).toEqual([7702, 3074]);
    expect(nums('EIPs 1559 & 4844')).toEqual([1559, 4844]);
  });

  it('requires 3+ digits in a continuation, so quantities are not swept up', () => {
    // 5 is a real EIP, but "and 5 others" is a count, not a reference.
    expect(nums('EIP-20 and 5 others')).toEqual([20]);
  });

  it('stops at a number that is not a real proposal', () => {
    expect(nums('EIP-7702 and 99999')).toEqual([7702]);
  });

  it('does not run past unrelated prose', () => {
    expect(nums('EIP-7702 improves on it. 3074 was the old way.')).toEqual([7702]);
  });
});

describe('Tier 2 — bare numbers', () => {
  it('is off unless explicitly allowed', () => {
    expect(nums('7702 changes EOAs')).toEqual([]);
  });

  it('matches a plausible bare reference when allowed', () => {
    expect(nums('7702 changes EOAs', true)).toEqual([7702]);
    expect(nums('4337 bundlers', true)).toEqual([4337]);
  });

  it('never matches numbers under 1000, the noisiest range', () => {
    // 20, 150 and 999 are all real proposals but hopeless as bare matches.
    expect(nums('20 items', true)).toEqual([]);
    expect(nums('150 users online', true)).toEqual([]);
    expect(nums('999 problems', true)).toEqual([]);
  });

  it('never matches year-shaped numbers, even though they are real proposals', () => {
    // 2015, 2020, 2025 and 2026 are all real proposal numbers.
    for (const year of ['2015', '2019', '2020', '2021', '2025', '2026']) {
      expect(nums(`back in ${year} things changed`, true)).toEqual([]);
      expect(nums(`${year} was a good year`, true)).toEqual([]);
    }
  });

  it('rejects year contexts and ranges', () => {
    expect(nums('since 2020', true)).toEqual([]);
    expect(nums('Q3 2026 roadmap', true)).toEqual([]);
    expect(nums('the 2024-2026 period', true)).toEqual([]);
    expect(nums('March 2020 update', true)).toEqual([]);
    expect(nums('© 2026 Foundation', true)).toEqual([]);
  });

  it('rejects currency and quantities', () => {
    expect(nums('$7702 raised', true)).toEqual([]);
    expect(nums('7702 USD', true)).toEqual([]);
    expect(nums('7702 users', true)).toEqual([]);
    expect(nums('7702 blocks', true)).toEqual([]);
    expect(nums('7702%', true)).toEqual([]);
  });

  it('rejects numbers that are part of a larger number', () => {
    expect(nums('1,7702', true)).toEqual([]);
    expect(nums('3.7702', true)).toEqual([]);
    expect(nums('7702.5', true)).toEqual([]);
    expect(nums('77021', true)).toEqual([]);
    expect(nums('1234567702', true)).toEqual([]);
  });

  it('rejects hex and identifiers by word boundary', () => {
    expect(nums('0x7702', true)).toEqual([]);
    expect(nums('0xdeadbeef7702', true)).toEqual([]);
    expect(nums('v7702', true)).toEqual([]);
    expect(nums('build-7702-rc1', true)).toEqual([]);
  });

  it('rejects date shapes', () => {
    expect(nums('2024/7702', true)).toEqual([]);
    expect(nums('7702/2024', true)).toEqual([]);
  });

  it('does not double-report a number already matched with a prefix', () => {
    expect(nums('EIP-7702 and 7702 again', true)).toEqual([7702, 7702]);
    // The prefixed match and the continuation each count once -- no third
    // bare match overlapping the same characters.
    expect(findMatches('EIP-7702', { isValid, allowBare: true })).toHaveLength(1);
  });
});

describe('bareLooksLikeProposal', () => {
  it('accepts a bare number in neutral prose', () => {
    const text = 'the 7702 delegation model';
    expect(bareLooksLikeProposal(text, 4, 8)).toBe(true);
  });

  it('rejects a bare number in a year context', () => {
    const text = 'in 2026 we ship';
    expect(bareLooksLikeProposal(text, 3, 7)).toBe(false);
  });
});

describe('isEthHost', () => {
  it('trusts known hosts', () => {
    expect(isEthHost('eips.ethereum.org')).toBe(true);
    expect(isEthHost('ethereum-magicians.org')).toBe(true);
    expect(isEthHost('www.ethresear.ch')).toBe(true);
    expect(isEthHost('notes.ethereum.org')).toBe(true);
  });

  it('leaves unknown hosts to the per-block gate', () => {
    expect(isEthHost('news.ycombinator.com')).toBe(false);
    expect(isEthHost('x.com')).toBe(false);
  });

  it('is not fooled by a lookalike host', () => {
    expect(isEthHost('ethereum.org.evil.com')).toBe(false);
  });
});

describe('Tier 2 — the per-block gate', () => {
  // Mirrors how the content script wires it: every block of text is judged on
  // its own, so a test string stands in for one segment.
  const anyTier = new Set([...VALID_NUMBERS, ...UNMERGED_NUMBERS]);
  const gated = (text: string) =>
    findMatches(text, { isValid: (n) => anyTier.has(n), allowBare: blockAllowsBare(text) }).map(
      (m) => m.n,
    );

  const TWEET =
    'just opened a proposal to enable native rollups via STARK-carrying frame ' +
    'transactions (8141 + 8288)';

  it('unlocks a block written entirely in bare numbers, on vocabulary alone', () => {
    // The case the old page-wide gate could never reach: x.com is not a trusted
    // host and the post has no prefixed reference, yet both numbers are real.
    expect(countEthTerms(TWEET)).toBeGreaterThanOrEqual(2);
    expect(gated(TWEET)).toEqual([8141, 8288]);
  });

  it('unlocks on two terms', () => {
    expect(countEthTerms('gas limit bump to 8141 in the next fork')).toBe(2);
    expect(gated('gas limit bump to 8141 in the next fork')).toEqual([8141]);
  });

  it('stays locked on one term, which is reachable by coincidence', () => {
    expect(countEthTerms('a fork at 8141')).toBe(1);
    expect(gated('a fork at 8141')).toEqual([]);
  });

  it('lets a prefixed reference unlock the bare numbers beside it', () => {
    expect(gated('EIP-7702 shipped; 4337 bundlers still matter.')).toEqual([7702, 4337]);
  });

  it('does not let one block unlock the block next to it', () => {
    // The regression that matters most. The gate used to ask whether the PAGE
    // contained a prefixed reference, so one post mentioning EIP-7702 unlocked
    // every unrelated post in the same timeline.
    const feed = [
      'EIP-7702 shipped; 4337 bundlers still matter.',
      'Final score 1023 to 4337 across the season, a record 8141 attendance',
    ];
    expect(feed.map(gated)).toEqual([[7702, 4337], []]);
  });

  describe('ordinary prose carrying 4-digit numbers stays locked', () => {
    it.each([
      'The RTX 4090 beats the 3080 and costs 1599 dollars at retail',
      'Our endpoint returns 8141 records per page with a 4096 byte limit',
      'Final score 1023 to 4337 across the season, a record 8141 attendance',
      'The company laid off 4337 staff and raised 8141 million in funding',
      'Bind to 8141 and forward 8288 through the proxy',
    ])('scores zero on %j', (text) => {
      expect(countEthTerms(text)).toBe(0);
      expect(blockAllowsBare(text)).toBe(false);
      expect(gated(text)).toEqual([]);
    });
  });

  it('accepts the terse-block tradeoff, which selection lookup covers', () => {
    expect(gated('thoughts on 8141?')).toEqual([]);
    expect(parseSelection('8141')!.n).toBe(8141);
  });

  describe('countEthTerms', () => {
    it('counts distinct terms, so repetition is not extra evidence', () => {
      expect(countEthTerms('gas gas gas')).toBe(1);
    });

    it('folds plurals into the singular', () => {
      expect(countEthTerms('rollups and transactions')).toBe(2);
      expect(countEthTerms('rollup rollups')).toBe(1);
    });

    it('is case-insensitive and respects word boundaries', () => {
      expect(countEthTerms('EVM opcodes')).toBe(2);
      expect(countEthTerms('the ethereal tx')).toBe(1);
      expect(countEthTerms('Prometheus and sethereum')).toBe(0);
    });
  });
});

describe('EIP/ERC namespace', () => {
  it('resolves both prefixes, since the number space is shared', () => {
    // 4337 is canonically an ERC; writing "EIP-4337" still refers to it.
    const m = findMatches('EIP-4337', { isValid })[0]!;
    expect(m.n).toBe(4337);
    expect(m.writtenKind).toBe('eip');
  });

  it('records the prefix as written so a mismatch can be surfaced', () => {
    expect(findMatches('ERC-7702', { isValid })[0]!.writtenKind).toBe('erc');
  });
});

describe('parseSelection — explicit user lookup', () => {
  const parse = (s: string) => parseSelection(s);

  it.each([
    ['8141', 8141, null],
    ['EIP-8141', 8141, 'eip'],
    ['eip 8141', 8141, 'eip'],
    ['EIP8141', 8141, 'eip'],
    ['#8141', 8141, null],
    ['ERC20', 20, 'erc'],
    ['erc-20', 20, 'erc'],
    ['EIPs 3074', 3074, 'eip'],
    ['EIP: 8141', 8141, 'eip'],
    ['EIP‑8141', 8141, 'eip'], // non-breaking hyphen, as copied from rendered pages
  ])('accepts %j', (input, n, kind) => {
    const m = parse(input)!;
    expect(m.n).toBe(n);
    expect(m.writtenKind).toBe(kind);
  });

  it('tolerates the whitespace a selection usually carries', () => {
    expect(parse('  8141 ')!.n).toBe(8141);
    expect(parse('\n  EIP-7702\n')!.n).toBe(7702);
  });

  describe('rejects anything that is not purely a reference', () => {
    // The anchoring is the whole safety property: selecting prose must never
    // trigger a lookup, or reading a page would pop tooltips constantly.
    it.each([
      'the 8141 proposal',
      '8141 + 8288',
      'frame transactions (8141)',
      'v8141',
      '0x8141',
      '8141.5',
      '8141-8288',
      'abc',
      '',
      '   ',
      'EIP',
      'EIP-',
      '123456',
    ])('rejects %j', (input) => {
      expect(parse(input)).toBeNull();
    });
  });

  it('deliberately skips the gates that automatic matching applies', () => {
    // Selecting a number is stronger evidence than any heuristic, so the digit
    // floor and the year rejection do not apply here. Automatic matching refuses
    // both of these even with bare numbers enabled.
    expect(parse('20')!.n).toBe(20);
    expect(parse('2025')!.n).toBe(2025);
    expect(nums('20', true)).toEqual([]);
    expect(nums('2025', true)).toEqual([]);
  });

  it('keeps the written prefix so the EIP/ERC mix-up note still works', () => {
    // 4337 is canonically an ERC; selecting "EIP-4337" should still resolve it
    // and be able to say it was referenced by the wrong name.
    expect(parse('EIP-4337')!.writtenKind).toBe('eip');
    expect(parse('4337')!.writtenKind).toBeNull();
  });
});
