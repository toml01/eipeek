import { describe, expect, it } from 'vitest';
import { buildSegment, locate, partsCovering } from '../src/core/segments';
import { findMatches } from '../src/core/match';
import { VALID_NUMBERS } from '../src/core/numbers.generated';

const isValid = (n: number) => new Set(VALID_NUMBERS).has(n);

/** Stand-ins for text nodes; the module is generic so no DOM is needed. */
const runs = (...texts: string[]) => texts.map((text, i) => ({ node: `n${i}`, text }));

describe('buildSegment', () => {
  it('joins runs into one string', () => {
    // Exactly how X search splits a bolded search term.
    expect(buildSegment(runs('EIP', '-', '7702', ' went live')).text).toBe('EIP-7702 went live');
  });

  it('records where each run landed', () => {
    expect(buildSegment(runs('EIP', '-', '7702')).parts).toEqual([
      { node: 'n0', start: 0, end: 3 },
      { node: 'n1', start: 3, end: 4 },
      { node: 'n2', start: 4, end: 8 },
    ]);
  });

  it('skips empty runs so they cannot produce zero-width parts', () => {
    const segment = buildSegment(runs('EIP', '', '-7702'));
    expect(segment.text).toBe('EIP-7702');
    expect(segment.parts).toHaveLength(2);
  });

  it('handles a single run', () => {
    const segment = buildSegment(runs('see EIP-7702 here'));
    expect(segment.parts).toEqual([{ node: 'n0', start: 0, end: 17 }]);
  });
});

describe('locate', () => {
  const segment = buildSegment(runs('EIP', '-', '7702', ' rocks'));

  it('maps an offset back to the owning run', () => {
    expect(locate(segment, 0)).toEqual({ node: 'n0', offset: 0 });
    expect(locate(segment, 2)).toEqual({ node: 'n0', offset: 2 });
    expect(locate(segment, 3)).toEqual({ node: 'n1', offset: 0 });
    expect(locate(segment, 4)).toEqual({ node: 'n2', offset: 0 });
    expect(locate(segment, 7)).toEqual({ node: 'n2', offset: 3 });
  });

  it('attaches the very last offset to the final run', () => {
    expect(locate(segment, segment.text.length)).toEqual({ node: 'n3', offset: 6 });
  });

  it('returns null outside the segment', () => {
    expect(locate(segment, 999)).toBeNull();
    expect(locate(buildSegment([]), 0)).toBeNull();
  });
});

describe('partsCovering', () => {
  const segment = buildSegment(runs('EIP', '-', '7702', ' rocks'));

  it('lists every run a match touches', () => {
    // "EIP-7702" spans the first three runs.
    expect(partsCovering(segment, 0, 8)).toEqual(['n0', 'n1', 'n2']);
  });

  it('excludes runs merely adjacent to the match', () => {
    expect(partsCovering(segment, 4, 8)).toEqual(['n2']);
    expect(partsCovering(segment, 0, 3)).toEqual(['n0']);
  });
});

describe('matching a split reference end to end', () => {
  it('finds and locates a reference split across runs', () => {
    const segment = buildSegment(runs('EIP', '-', '7702', ' went live in may 2025.'));
    const [match] = findMatches(segment.text, { isValid });

    expect(match!.n).toBe(7702);
    // The range must start in the run holding "EIP" and end in the one
    // holding the digits -- a Range may legitimately span nodes.
    expect(locate(segment, match!.start)).toEqual({ node: 'n0', offset: 0 });
    expect(locate(segment, match!.end)).toEqual({ node: 'n3', offset: 0 });
  });

  it('finds a split reference with no separator run', () => {
    const segment = buildSegment(runs('ERC', '20', ' approvals'));
    const [match] = findMatches(segment.text, { isValid });
    expect(match!.n).toBe(20);
    expect(match!.text).toBe('ERC20');
  });

  it('ignores the year in the joined tail under the alpha filters', () => {
    const segment = buildSegment(runs('EIP', '-', '7702', ' went live in may 2025.'));
    expect(
      findMatches(segment.text, { isValid, allowBare: true, strictBare: true }).map((m) => m.n),
    ).toEqual([7702]);
    // Unrestricted, 2025 is a real proposal number and gets marked -- the joining
    // is what is under test here, and it behaves the same either way.
    expect(findMatches(segment.text, { isValid, allowBare: true }).map((m) => m.n)).toEqual([
      7702, 2025,
    ]);
  });
});
