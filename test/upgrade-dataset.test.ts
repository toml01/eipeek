import { describe, expect, it } from 'vitest';
import {
  attachUpgradeRelationships,
  bpoRelationships,
  mergeUpgradeRelationships,
  normalizeUpgradeName,
  parseBpoMeta,
  parseEelsProtocolHistory,
  parseForkcastEip,
  type Proposal,
  type UpgradeRelationship,
} from '../scripts/build-dataset';

const eelsHistory = (rows: string[]) => `
# Protocol History

## Mainnet hardforks
| Version and Code Name | Block No. | Released | Incl EIPs | Fork Specifications | Blog |
|-----------------------|-----------|----------|-----------|---------------------|------|
${rows.join('\n')}

## Clarifications without a protocol release
| EIP | Block No. |
|-----|-----------|
| [EIP-9999](example) | 0 |
`;

const relationship = (
  proposal: number,
  name: string,
  status: 'included' | 'scheduled',
  order: number,
  source = status === 'included' ? 'EELS' : 'Forkcast fixture.json',
): UpgradeRelationship => ({ proposal, name, status, order, source });

const proposal = (n: number, overrides: Partial<Proposal> = {}): Proposal => ({
  n,
  t: `Proposal ${n}`,
  d: '',
  s: 'Draft',
  ty: 'Standards Track',
  c: 'Core',
  k: 'eip',
  disc: '',
  cr: '2026-01-01',
  req: [],
  ...overrides,
});

describe('upgrade names and EELS protocol history', () => {
  it('normalizes layer fork names to common upgrade names', () => {
    expect(
      ['Cancun', 'Prague', 'Osaka', 'Shanghai', 'Paris', 'Amsterdam', 'Hegota'].map(
        normalizeUpgradeName,
      ),
    ).toEqual([
      'Dencun',
      'Pectra',
      'Fusaka',
      'Shapella',
      'The Merge',
      'Glamsterdam',
      'Hegotá',
    ]);
    expect(normalizeUpgradeName('London')).toBe('London');
  });

  it('parses only the activated mainnet table and retains repeated EIPs across forks', () => {
    const parsed = parseEelsProtocolHistory(
      eelsHistory([
        '| Osaka | 23 | 2025-12-03 | [EIP-7892] <br> [EIP-7918] | spec | blog |',
        '| Prague | 22 | 2025-05-07 | [EIP-7702] | spec | blog |',
        '| Cancun | 19 | 2024-03-13<br />(1710338135) | [EIP-4844](example) | spec | blog |',
        '| Petersburg | 7 | 2019-02-28 | [EIP-145](example) | spec | blog |',
        '| Constantinople | 7 | 2019-02-28 | [EIP-145](example) | spec | blog |',
        '| Frontier | 1 | 2015-07-30 | | spec | blog |',
      ]),
    );

    expect(parsed.map(({ proposal, name, status }) => ({ proposal, name, status }))).toEqual([
      { proposal: 7892, name: 'Fusaka', status: 'included' },
      { proposal: 7918, name: 'Fusaka', status: 'included' },
      { proposal: 7702, name: 'Pectra', status: 'included' },
      { proposal: 4844, name: 'Dencun', status: 'included' },
      { proposal: 145, name: 'Petersburg', status: 'included' },
      { proposal: 145, name: 'Constantinople', status: 'included' },
    ]);
    expect(parsed.some((item) => item.proposal === 9999)).toBe(false);
  });

  it('fails on table schema drift and duplicate relationships', () => {
    expect(() => parseEelsProtocolHistory('# Protocol History')).toThrow('missing mainnet');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory([
          '| London | 12 | 2021-08-05 | [EIP-1559] <br> [EIP-1559] | spec | blog |',
        ]),
      ),
    ).toThrow('duplicate relationship');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory(['| London | 12 | 2021-08-05 | [EIP-1559] <br> EIP-TBD | spec | blog |']),
      ),
    ).toThrow('invalid included EIP-TBD');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory(['| London | 12 | 2021-08-05 | [EIP-0] | spec | blog |']),
      ),
    ).toThrow('invalid included EIP-0');
  });
});

describe('Forkcast scheduled relationships', () => {
  const forkcast = (forkRelationships: unknown, id = 7708) =>
    JSON.stringify({ id, title: `EIP-${id}`, forkRelationships });

  it('uses the latest status and excludes considered and declined memberships', () => {
    const parsed = parseForkcastEip(
      forkcast([
        {
          forkName: 'Glamsterdam',
          statusHistory: [{ status: 'Proposed' }, { status: 'Considered' }, { status: 'Scheduled' }],
        },
        {
          forkName: 'Hegota',
          statusHistory: [{ status: 'Considered' }, { status: 'Declined' }],
        },
      ]),
      '7708.json',
    );

    expect(parsed).toMatchObject([
      { proposal: 7708, name: 'Glamsterdam', status: 'scheduled' },
    ]);
  });

  it('normalizes Hegotá and validates every status, id and relationship', () => {
    expect(
      parseForkcastEip(
        forkcast([{ forkName: 'Hegota', statusHistory: [{ status: 'Scheduled' }] }], 7805),
        '7805.json',
      )[0]?.name,
    ).toBe('Hegotá');
    expect(() =>
      parseForkcastEip(
        forkcast([{ forkName: 'Glamsterdam', statusHistory: [{ status: 'Accepted' }] }]),
        '7708.json',
      ),
    ).toThrow('unrecognized status');
    expect(() => parseForkcastEip(forkcast([], 7708), '9999.json')).toThrow('does not match');
    expect(() =>
      parseForkcastEip(
        forkcast([
          { forkName: 'Hegota', statusHistory: [{ status: 'Considered' }] },
          { forkName: 'Hegotá', statusHistory: [{ status: 'Scheduled' }] },
        ]),
        '7708.json',
      ),
    ).toThrow('duplicate relationship');
    expect(() =>
      parseForkcastEip(
        forkcast([{ forkName: 'Futurefork', statusHistory: [{ status: 'Scheduled' }] }]),
        '7708.json',
      ),
    ).toThrow('no chronological order is known');
  });
});

describe('BPO Meta EIPs', () => {
  const bpo = ({
    eip = 8134,
    title = 'Hardfork Meta - BPO1',
    status = 'Final',
    requires = '7892',
    activation = '1765290071',
  } = {}) => `---
eip: ${eip}
title: ${title}
description: Blob parameter changes on Ethereum mainnet.
status: ${status}
type: Meta
requires: ${requires}
---
| Field | Value |
|---|---|
| BPO Identifier | BPO${/BPO(\d+)/.exec(title)?.[1] ?? '1'} |
| Activation Time (UTC) | ${activation} |
`;

  it('marks activated Final metas included and activated non-Final metas scheduled', () => {
    expect(parseBpoMeta(bpo())).toMatchObject({
      meta: 8134,
      name: 'BPO1',
      status: 'included',
      activation: 1_765_290_071_000,
      requires: [7892],
    });
    expect(parseBpoMeta(bpo({ status: 'Draft' }))).toMatchObject({ status: 'scheduled' });
  });

  it('leaves an incomplete BPO draft unscheduled', () => {
    const parsed = parseBpoMeta(
      bpo({
        eip: 8138,
        title: 'Hardfork Meta - BPO3',
        status: 'Draft',
        activation: '<!-- TODO -->',
      }),
    );
    expect(parsed).toMatchObject({ meta: 8138, name: 'BPO3', status: 'scheduled' });
    expect(parsed?.activation).toBeUndefined();
  });

  it('fails if a Final BPO lacks an activation or its identifier drifts', () => {
    expect(() => parseBpoMeta(bpo({ activation: '<!-- TODO -->' }))).toThrow(
      'Final BPO Meta EIP has no concrete activation',
    );
    expect(() =>
      parseBpoMeta(
        bpo().replace('| BPO Identifier | BPO1 |', '| BPO Identifier | BPO2 |'),
      ),
    ).toThrow('BPO Identifier does not match');
    expect(() =>
      parseBpoMeta(`${bpo()}| Activation Time (UTC) | 1765290072 |\n`),
    ).toThrow('exactly one BPO activation');
  });

  it('validates every requires token and rejects duplicates', () => {
    expect(() => parseBpoMeta(bpo({ requires: '7892, TBD' }))).toThrow(
      'invalid BPO requirement',
    );
    expect(() => parseBpoMeta(bpo({ requires: '7892, 7892' }))).toThrow(
      'duplicate BPO requirement',
    );
    expect(() => parseBpoMeta(bpo().replace('type: Meta', 'type: Informational'))).toThrow(
      'not a Meta EIP',
    );
  });

  it('associates only non-Meta protocol dependencies and omits incomplete drafts', () => {
    const merged = new Map([
      [7892, proposal(7892, { ty: 'Informational' })],
      [8134, proposal(8134, { ty: 'Meta' })],
    ]);
    const complete = parseBpoMeta(
      bpo({ eip: 8135, title: 'Hardfork Meta - BPO2', requires: '7892, 8134' }),
    )!;
    const incomplete = parseBpoMeta(
      bpo({
        eip: 8138,
        title: 'Hardfork Meta - BPO3',
        status: 'Draft',
        activation: '<!-- TODO -->',
      }),
    )!;

    expect(bpoRelationships([complete, incomplete], merged)).toEqual([
      expect.objectContaining({ proposal: 7892, name: 'BPO2', status: 'included' }),
    ]);
  });
});

describe('upgrade relationship validation and attachment', () => {
  it('lets an EELS activation replace a stale scheduled relationship', () => {
    expect(
      mergeUpgradeRelationships([
        relationship(7702, 'Pectra', 'scheduled', 10),
        relationship(7702, 'Pectra', 'included', 5, 'EELS'),
      ]),
    ).toEqual([relationship(7702, 'Pectra', 'included', 5, 'EELS')]);
  });

  it('rejects duplicate relationships', () => {
    expect(() =>
      mergeUpgradeRelationships([
        relationship(145, 'Constantinople', 'included', 1),
        relationship(145, 'Constantinople', 'included', 1),
      ]),
    ).toThrow('duplicate upgrade relationship');
  });

  it('attaches only to a unique EIP and orders included before scheduled', () => {
    const eip = proposal(7892, { req: [8134] });
    const erc = proposal(7892, { k: 'erc' });
    expect(
      attachUpgradeRelationships(
        [eip, erc],
        [
          relationship(7892, 'BPO2', 'included', 30, 'BPO Meta EIP-8135'),
          relationship(7892, 'Fusaka', 'included', 10),
          relationship(7892, 'BPO1', 'included', 20, 'BPO Meta EIP-8134'),
          relationship(7892, 'Glamsterdam', 'scheduled', 1),
        ],
      ),
    ).toEqual([]);
    expect(eip.u).toEqual([
      { n: 'Fusaka', s: 'included' },
      { n: 'BPO1', s: 'included' },
      { n: 'BPO2', s: 'included' },
      { n: 'Glamsterdam', s: 'scheduled' },
    ]);
    expect(erc.u).toBeUndefined();
  });

  it('does not resolve authoritative membership through a curated alias', () => {
    const canonical = proposal(8361);
    const aliased = proposal(8363, { aka: [8361] });
    expect(
      attachUpgradeRelationships(
        [canonical, aliased],
        [relationship(8361, 'Glamsterdam', 'scheduled', 1)],
      ),
    ).toEqual([]);
    expect(canonical.u).toEqual([{ n: 'Glamsterdam', s: 'scheduled' }]);
    expect(aliased.u).toBeUndefined();
  });

  it('reports missing and ambiguous referenced EIPs without partially attaching', () => {
    const first = proposal(7708);
    const rival = proposal(7708, { pr: 123 });
    const errors = attachUpgradeRelationships(
      [first, rival],
      [
        relationship(7708, 'Glamsterdam', 'scheduled', 1),
        relationship(9999, 'Hegotá', 'scheduled', 2),
      ],
    );
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('ambiguous');
    expect(errors.join('\n')).toContain('missing');
    expect(first.u).toBeUndefined();
  });
});
