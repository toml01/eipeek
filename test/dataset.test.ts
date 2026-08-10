import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import proposals from '../data/eips.json';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../src/core/numbers.generated';
import { aliasNumbers, linksFor, sourceUrl, specUrl, statusLine, usableDiscussion } from '../src/core/links';
import { isUnmerged, type Proposal } from '../src/core/types';

const all = proposals as Proposal[];
const merged = all.filter((p) => !isUnmerged(p));
const unmerged = all.filter(isUnmerged);

/** Every proposal reachable by a number, including via a curated alias. */
const resolve = (n: number) => all.filter((p) => p.n === n || (p.aka ?? []).includes(n));

const aliases = JSON.parse(readFileSync('data/aliases.json', 'utf8')) as Array<{
  canonical: number;
  alsoKnownAs: number[];
  target: { pr?: number; repo?: string; n?: number };
  reason: string;
}>;

describe('dataset integrity', () => {
  it('has a plausible number of proposals in each tier', () => {
    expect(merged.length).toBeGreaterThan(1100);
    expect(merged.length).toBeLessThan(1600);
    expect(unmerged.length).toBeGreaterThan(20);
    expect(unmerged.length).toBeLessThan(600);
  });

  it('assigns each number exactly one MERGED proposal', () => {
    // Merged numbers are authoritative. Only open PRs can contest a number.
    const numbers = merged.map((p) => p.n);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('never lets an open-PR proposal shadow a merged one', () => {
    const mergedNumbers = new Set(merged.map((p) => p.n));
    expect(unmerged.filter((p) => mergedNumbers.has(p.n)).map((p) => p.n)).toEqual([]);
  });

  it('keeps exactly one EIP-1, from the EIPs repo', () => {
    const ones = merged.filter((p) => p.n === 1);
    expect(ones).toHaveLength(1);
    expect(ones[0]!.k).toBe('eip');
  });

  it('never retains YAML quote characters in a title', () => {
    // Regression guard: 16 titles are YAML-quoted upstream because they
    // contain a colon, e.g. title: "Hardfork Meta: Homestead".
    expect(all.filter((p) => /^["']|["']$/.test(p.t)).map((p) => p.n)).toEqual([]);
  });

  it('preserves colons inside quoted titles', () => {
    expect(resolve(606)[0]!.t).toBe('Hardfork Meta: Homestead');
    expect(resolve(211)[0]!.t).toBe('New opcodes: RETURNDATASIZE and RETURNDATACOPY');
  });

  it('excludes "Moved" stubs', () => {
    expect(all.some((p) => p.s === 'Moved')).toBe(false);
  });

  it('always has a title, status and type', () => {
    expect(all.filter((p) => !p.t || !p.s).map((p) => p.n)).toEqual([]);
  });

  it('gives every open-PR proposal full provenance', () => {
    const bad = unmerged.filter((p) => !p.pr || !p.prRepo || !p.prRef || !p.prHead || !p.prOpened);
    expect(bad.map((p) => p.n)).toEqual([]);
  });

  it('rejects placeholder numbers from open PRs', () => {
    // eip-XXXX.md, eip-aass.md and friends are filtered by requiring a numeric
    // filename; 0 is the "assign me a number" placeholder.
    expect(all.filter((p) => p.n < 1000 && isUnmerged(p)).map((p) => p.n)).toEqual([]);
    expect(all.some((p) => p.n === 0)).toBe(false);
  });

  it('matches the inlined number indexes', () => {
    const expectedMerged = new Set(merged.flatMap((p) => [p.n, ...(p.aka ?? [])]));
    expect([...VALID_NUMBERS].sort((a, b) => a - b)).toEqual(
      [...expectedMerged].sort((a, b) => a - b),
    );
    // The unmerged index excludes anything already merged, so the two lists
    // never overlap and the "include open PRs" setting is a clean switch.
    expect([...UNMERGED_NUMBERS].filter((n) => expectedMerged.has(n))).toEqual([]);
  });

  it('can resolve every number in both indexes', () => {
    for (const n of [...VALID_NUMBERS, ...UNMERGED_NUMBERS]) {
      expect(resolve(n).length, `number ${n}`).toBeGreaterThan(0);
    }
  });
});

describe('contested numbers', () => {
  it('returns every claimant, earliest pull request first', () => {
    // EIP-8361: #12075 "Transaction Validity Proofs" holds it legitimately, and
    // #12081 "Tapered Issuance Burn" self-assigned it. An editor confirmed the
    // allocation to #12075, and PR creation order is the only signal that agrees
    // -- CI passes on both, and #12075 is a GitHub *draft* while #12081 is not,
    // so ordering by last-updated or filtering drafts would rank the invalid
    // claim first.
    const claims = resolve(8361);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.every(isUnmerged)).toBe(true);
    expect(claims[0]!.pr).toBe(12075);
  });

  it('sorts merged before unmerged within one number', () => {
    for (const n of new Set(all.map((p) => p.n))) {
      const group = all.filter((p) => p.n === n);
      const firstUnmerged = group.findIndex(isUnmerged);
      if (firstUnmerged === -1) continue;
      expect(group.slice(firstUnmerged).every(isUnmerged), `number ${n}`).toBe(true);
    }
  });
});

describe('aliases', () => {
  it('files a renumbered proposal under the number an editor assigned', () => {
    // 8363 is the real number: the Hegota list cites it, and the Magicians thread
    // redirects to eip-8363-tapered-issuance-burn. 8361 was self-assigned and an
    // editor asked for it not to be used -- so it is the alias, not the primary.
    const p = resolve(8363);
    expect(p).toHaveLength(1);
    expect(p[0]!.n).toBe(8363);
    expect(p[0]!.t).toBe('Tapered Issuance Burn');
    expect(p[0]!.aka).toEqual([8361]);
  });

  it('still resolves the stale number people actually write', () => {
    // The point of the feature: X discussion says 8361, so it has to work.
    const viaStale = resolve(8361).find((x) => x.t === 'Tapered Issuance Burn');
    expect(viaStale).toBeDefined();
    expect(viaStale).toBe(resolve(8363)[0]);
  });

  it('reports the aliases, so the tooltip can lead with the canonical number', () => {
    expect(aliasNumbers(resolve(8363)[0]!)).toEqual([8361]);
  });

  it('always links source at the filename, never the canonical number', () => {
    // An aliased proposal's file often lags its assigned number, so the source
    // link must follow `prFileN` when it is set. Asserted as an invariant rather
    // than against one PR: upstream renames its file eventually, which is
    // exactly what happened to #12081 (eip-8361.md -> eip-8363.md).
    for (const p of all.filter((x) => x.aka?.length && isUnmerged(x))) {
      const fileN = p.prFileN ?? p.n;
      const dir = p.prRepo === 'ERCs' ? 'ERCS' : 'EIPS';
      const stem = p.prRepo === 'ERCs' ? 'erc' : 'eip';
      expect(sourceUrl(p), `pr #${p.pr}`).toContain(`/${dir}/${stem}-${fileN}.md`);
    }
  });

  it('files the renumbered ERC under 8351 and keeps 8338 resolving', () => {
    // ERCs PR #1913 still ships erc-8338.md, but the forum thread redirects to
    // erc-8351-..., so 8351 is the assigned number.
    const p = resolve(8351);
    expect(p).toHaveLength(1);
    expect(p[0]!.t).toBe('Prediction Market CTF Wrapper');
    expect(p[0]!.aka).toEqual([8338]);
    expect(p[0]!.prFileN).toBe(8338);
    // The source link must follow the filename, not the canonical number.
    expect(sourceUrl(p[0]!)).toContain('/ERCS/erc-8338.md');
  });

  it('leaves 8338 contested between the two claimants', () => {
    const claims = resolve(8338);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.pr).sort()).toEqual([1879, 1913]);
    // #1879 still holds 8338 as its own number; #1913 reaches it via the alias.
    expect(claims.find((c) => c.pr === 1879)!.n).toBe(8338);
    expect(claims.find((c) => c.pr === 1913)!.n).toBe(8351);
  });

  it('documents every alias entry', () => {
    // An undocumented entry is unauditable, and nobody will know when to retire it.
    for (const entry of aliases) {
      expect(entry.reason?.trim(), `entry ${entry.canonical}`).toBeTruthy();
      expect(entry.target.pr ?? entry.target.n, `entry ${entry.canonical}`).toBeDefined();
    }
  });

  it('never gives two proposals the same canonical number', () => {
    for (const entry of aliases) {
      expect(all.filter((p) => p.n === entry.canonical), `entry ${entry.canonical}`).toHaveLength(1);
    }
  });

  it('allows an alias to overlap another proposal, which is the contested case', () => {
    // 8361 is both this proposal's alias and #12075's real number. That overlap is
    // expected -- the tooltip shows both and lets the reader judge.
    const claims = resolve(8361);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.some((p) => p.n === 8361)).toBe(true);
    expect(claims.some((p) => p.n === 8363)).toBe(true);
  });

  it('points every entry at a proposal that exists', () => {
    for (const entry of aliases) {
      const target = entry.target.pr
        ? all.find((p) => p.pr === entry.target.pr && p.prRepo === entry.target.repo)
        : merged.find((p) => p.n === entry.target.n);
      expect(target, `entry ${entry.canonical}`).toBeDefined();
      expect(target!.n).toBe(entry.canonical);
    }
  });
});

describe('spot checks', () => {
  it('resolves EIP-7702 as merged', () => {
    const p = resolve(7702)[0]!;
    expect(p.t).toBe('Set Code for EOAs');
    expect(isUnmerged(p)).toBe(false);
    expect(statusLine(p)).toBe('Final · Core');
  });

  it('resolves ERC-4337 to the ERCs repo', () => {
    const p = resolve(4337)[0]!;
    expect(p.t).toBe('Account Abstraction Using Alt Mempool');
    expect(p.k).toBe('erc');
  });

  it('resolves EIP-8081, which is merged despite being discussed as new', () => {
    const p = resolve(8081);
    expect(p).toHaveLength(1);
    expect(p[0]!.t).toBe('Hardfork Meta - Hegotá');
    expect(isUnmerged(p[0]!)).toBe(false);
  });
});

describe('links', () => {
  it('uses one canonical spec URL for both kinds', () => {
    // eips.ethereum.org/EIPS/eip-N resolves for ERC-only proposals too.
    expect(specUrl(7702)).toBe('https://eips.ethereum.org/EIPS/eip-7702');
    expect(specUrl(4337)).toBe('https://eips.ethereum.org/EIPS/eip-4337');
  });

  it('points a merged source link at the right repo', () => {
    expect(sourceUrl(resolve(7702)[0]!)).toContain('/ethereum/EIPs/blob/master/EIPS/eip-7702.md');
    expect(sourceUrl(resolve(4337)[0]!)).toContain('/ethereum/ERCs/blob/master/ERCS/erc-4337.md');
  });

  it('replaces the spec link with the pull request when unmerged', () => {
    // eips.ethereum.org/EIPS/eip-8363 is a 404, so linking it would be worse
    // than useless.
    const p = resolve(8363)[0]!;
    const labels = linksFor(p).map((l) => l.label);
    expect(labels).toContain('Pull request');
    expect(labels).not.toContain('Spec');
    expect(linksFor(p)[0]!.url).toBe('https://github.com/ethereum/EIPs/pull/12081');
  });

  it('pins an unmerged source link to the fork and head commit', () => {
    const p = resolve(8365)[0]!;
    expect(sourceUrl(p)).toBe(
      `https://github.com/${p.prHead}/blob/${p.prRef}/EIPS/eip-${p.n}.md`,
    );
  });

  it('drops discussion values that are not URLs at all', () => {
    // Real values from open-PR frontmatter, which is unreviewed.
    expect(usableDiscussion('TBD')).toBe(false);
    expect(usableDiscussion('self')).toBe(false);
    expect(usableDiscussion('')).toBe(false);
    expect(usableDiscussion('https://ethereum-magicians.org/t/eip-7702-set-code/19923')).toBe(true);
  });

  it('keeps eip-xxxx slugs, which look like placeholders but resolve', () => {
    // Discourse resolves by the trailing topic id and redirects to the current
    // slug -- this one lands on eip-8363-tapered-issuance-burn. Verified live.
    expect(
      usableDiscussion('https://ethereum-magicians.org/t/eip-xxxx-tapered-issuance-burn/29263'),
    ).toBe(true);
  });

  it('omits the discussion link when upstream has none or it is a placeholder', () => {
    const withDisc = merged.find((p) => usableDiscussion(p.disc))!;
    const withoutDisc = merged.find((p) => !p.disc)!;
    expect(linksFor(withDisc).map((l) => l.label)).toEqual(['Spec', 'Discussion', 'Source']);
    expect(linksFor(withoutDisc).map((l) => l.label)).toEqual(['Spec', 'Source']);
  });

  it('falls back to type when a proposal has no category', () => {
    // Meta and Informational proposals correctly have no category.
    const meta = merged.find((p) => !p.c)!;
    expect(statusLine(meta)).toBe(`${meta.s} · ${meta.ty}`);
  });

  it('produces only https links', () => {
    for (const p of all) {
      for (const link of linksFor(p)) {
        expect(link.url, `eip-${p.n}`).toMatch(/^https:\/\//);
      }
    }
  });
});
