import { describe, expect, it } from 'vitest';
import {
  bareIsWholeNumber,
  bareLooksLikeProposal,
  blockAllowsBare,
  countEthTerms,
  findMatches,
  parseSelection,
} from '../src/core/match';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../src/core/numbers.generated';

const valid = new Set(VALID_NUMBERS);
const isValid = (n: number) => valid.has(n);

const nums = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.n);

const texts = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.text);

/** Bare matching under the `predictEthBlocks` alpha setting. */
const strict = (text: string) =>
  findMatches(text, { isValid, allowBare: true, strictBare: true }).map((m) => m.n);

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

describe('Tier 2 — bare numbers, unrestricted', () => {
  it('is off unless explicitly allowed', () => {
    expect(nums('7702 changes EOAs')).toEqual([]);
  });

  it('matches a plausible bare reference when allowed', () => {
    expect(nums('7702 changes EOAs', true)).toEqual([7702]);
    expect(nums('4337 bundlers', true)).toEqual([4337]);
  });

  it('matches numbers under 1000, including single digits', () => {
    // The scale change: EIPs 1-8, 20, 55, 67 and 86 exist, so ordinary counts
    // get marked. Accepted, because the setting is off by default.
    expect(nums('20 items', true)).toEqual([20]);
    expect(nums('150 users online', true)).toEqual([150]);
    expect(nums('999 problems', true)).toEqual([999]);
    expect(nums('I have 3 apples', true)).toEqual([3]);
    expect(nums('7', true)).toEqual([7]);
  });

  it('matches year-shaped numbers that are real proposals', () => {
    expect(nums('2025', true)).toEqual([2025]);
    expect(nums('back in 2025 things changed', true)).toEqual([2025]);
    expect(nums('© 2026 Foundation', true)).toEqual([2026]);
    // 2024 is not a proposal, so it stays unmarked whatever the mode.
    expect(nums('back in 2024 things changed', true)).toEqual([]);
  });

  it('matches in currency, percentage and quantity contexts', () => {
    expect(nums('$7702 raised', true)).toEqual([7702]);
    expect(nums('7702 users', true)).toEqual([7702]);
    expect(nums('7702%', true)).toEqual([7702]);
  });

  it('matches in date and identifier shapes, which are only wrong by meaning', () => {
    expect(nums('2024/7702', true)).toEqual([7702]);
    expect(nums('build-7702-rc1', true)).toEqual([7702]);
    // The reference the old slug rule threw away.
    expect(nums('pre-7702 behaviour', true)).toEqual([7702]);
  });

  it('needs no Ethereum vocabulary in the block', () => {
    const post = 'Final score 1023 to 4337, a record 8141 attendance';
    expect(countEthTerms(post)).toBe(0);
    // 1023 is not a proposal; 4337 and 8141 are.
    expect(nums(post, true)).toEqual([4337, 8141]);
  });

  it('still rejects numbers that are not real proposals', () => {
    expect(nums('1023 seats and 4090 cards', true)).toEqual([]);
  });

  it('does not double-report a number already matched with a prefix', () => {
    expect(nums('EIP-7702 and 7702 again', true)).toEqual([7702, 7702]);
    // The prefixed match and the continuation each count once -- no third
    // bare match overlapping the same characters.
    expect(findMatches('EIP-7702', { isValid, allowBare: true })).toHaveLength(1);
  });
});

describe('Tier 2 — structural checks, which apply in both modes', () => {
  // These are not guesses about meaning: they decide which number the text
  // holds, so dropping them would highlight a number nobody wrote.
  const cases: Array<[string, number[]]> = [
    ['77021', []],
    ['3.7702', []],
    ['7702.5', []],
    ['1234567702', []],
    ['0x7702', []],
    ['0xdeadbeef7702', []],
    ['v7702', []],
    ['7702x', []],
    // A hyphen joins nothing, so both numbers here are whole.
    ['7702-7710', [7702, 7710]],
    // Nor does a comma. "8081,7022" is a list far more often than a thousands
    // group, so both digit runs are whole numbers -- 7022 is simply not a
    // proposal. Only the alpha filters read a comma as grouping.
    ['8081,7702', [8081, 7702]],
    ['8081,7022', [8081]],
  ];

  it.each(cases)('reads %j as %j in unrestricted mode', (text, expected) => {
    expect(nums(text, true)).toEqual(expected);
  });

  it.each(cases.filter(([, expected]) => expected.length === 0))(
    'also rejects %j in alpha mode',
    (text) => {
      expect(strict(text)).toEqual([]);
    },
  );

  it('accepts a whole number and rejects a decimal fragment', () => {
    expect(bareIsWholeNumber('the 7702 model', 4, 8)).toBe(true);
    expect(bareIsWholeNumber('7702.5', 0, 4)).toBe(false);
    expect(bareIsWholeNumber('3.7702', 2, 6)).toBe(false);
    // A comma is not structural, so this is whole here and filtered in alpha.
    expect(bareIsWholeNumber('1,7702', 2, 6)).toBe(true);
  });

  it('treats a comma as thousands grouping only in alpha mode', () => {
    // Both runs are whole numbers here, and EIP-1 exists -- so unrestricted mode
    // marks it. That is the accepted cost of matching single digits.
    expect(nums('1,7702', true)).toEqual([1, 7702]);
    expect(strict('1,7702')).toEqual([]);
    expect(nums('17,702', true)).toEqual([]); // 17 and 702 are not proposals
  });
});

describe('Tier 2 — predictEthBlocks (alpha)', () => {
  it('never matches numbers under 1000, the noisiest range', () => {
    // 20, 150 and 999 are all real proposals but hopeless as bare matches.
    expect(strict('20 items')).toEqual([]);
    expect(strict('150 users online')).toEqual([]);
    expect(strict('999 problems')).toEqual([]);
  });

  it('never matches year-shaped numbers, even though they are real proposals', () => {
    // 2015, 2020, 2025 and 2026 are all real proposal numbers.
    for (const year of ['2015', '2019', '2020', '2021', '2025', '2026']) {
      expect(strict(`back in ${year} things changed`)).toEqual([]);
      expect(strict(`${year} was a good year`)).toEqual([]);
    }
  });

  it('rejects year contexts and ranges', () => {
    expect(strict('since 2020')).toEqual([]);
    expect(strict('Q3 2026 roadmap')).toEqual([]);
    expect(strict('the 2024-2026 period')).toEqual([]);
    expect(strict('March 2020 update')).toEqual([]);
    expect(strict('© 2026 Foundation')).toEqual([]);
  });

  it('rejects currency and quantities', () => {
    expect(strict('$7702 raised')).toEqual([]);
    expect(strict('7702 USD')).toEqual([]);
    expect(strict('7702 users')).toEqual([]);
    expect(strict('7702 blocks')).toEqual([]);
    expect(strict('7702%')).toEqual([]);
  });

  it('rejects hyphenated identifiers and date shapes', () => {
    expect(strict('build-7702-rc1')).toEqual([]);
    expect(strict('pre-7702 behaviour')).toEqual([]);
    expect(strict('2024/7702')).toEqual([]);
    expect(strict('7702/2024')).toEqual([]);
  });

  it('still matches a plausible bare reference', () => {
    expect(strict('7702 changes EOAs')).toEqual([7702]);
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

describe('Tier 2 — the per-block gate (alpha)', () => {
  // Mirrors how the content script wires it under `predictEthBlocks`: every block
  // of text is judged on its own, so a test string stands in for one segment.
  const anyTier = new Set([...VALID_NUMBERS, ...UNMERGED_NUMBERS]);
  const gated = (text: string) =>
    findMatches(text, {
      isValid: (n) => anyTier.has(n),
      allowBare: blockAllowsBare(text),
      strictBare: true,
    }).map((m) => m.n);

  /** The same text with the gate off, i.e. what the default mode does with it. */
  const ungated = (text: string) =>
    findMatches(text, { isValid: (n) => anyTier.has(n), allowBare: true }).map((m) => m.n);

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
    // Same text, default mode: no gate to fail.
    expect(ungated('a fork at 8141')).toEqual([8141]);
  });

  it('lets a prefixed reference unlock the bare numbers beside it', () => {
    expect(gated('EIP-7702 shipped; 4337 bundlers still matter.')).toEqual([7702, 4337]);
  });

  it('does not let one block unlock the block next to it', () => {
    // The regression that matters most, and the reason the gate is evaluated per
    // block: it used to ask whether the PAGE contained a prefixed reference, so
    // one post mentioning EIP-7702 unlocked every unrelated post in the timeline.
    const feed = [
      'EIP-7702 shipped; 4337 bundlers still matter.',
      'Final score 1023 to 4337 across the season, a record 8141 attendance',
    ];
    expect(feed.map(gated)).toEqual([[7702, 4337], []]);
    // The neighbour is locked by its own content, not by anything page-wide:
    // with the gate off it matches, which is what the default mode does.
    expect(feed.map(ungated)).toEqual([
      [7702, 4337],
      [4337, 8141],
    ]);
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
    // The tradeoff only exists in alpha mode.
    expect(ungated('thoughts on 8141?')).toEqual([8141]);
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
    // floor and the year rejection do not apply here. Alpha mode refuses both of
    // these even with bare numbers enabled; a selection resolves them anyway.
    expect(parse('20')!.n).toBe(20);
    expect(parse('2025')!.n).toBe(2025);
    expect(strict('20')).toEqual([]);
    expect(strict('2025')).toEqual([]);
  });

  it('keeps the written prefix so the EIP/ERC mix-up note still works', () => {
    // 4337 is canonically an ERC; selecting "EIP-4337" should still resolve it
    // and be able to say it was referenced by the wrong name.
    expect(parse('EIP-4337')!.writtenKind).toBe('eip');
    expect(parse('4337')!.writtenKind).toBeNull();
  });
});
