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
  meta =
    new Map([
      ['Constantinople', 1013],
      ['Petersburg', 1716],
      ['Dencun', 7569],
      ['Pectra', 7600],
      ['Fusaka', 7607],
      ['Glamsterdam', 7773],
      ['Hegotá', 8081],
      ['BPO1', 8134],
      ['BPO2', 8135],
    ]).get(name) ?? 9000,
): UpgradeRelationship => ({ proposal, name, status, meta, order, source });

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

const metaProposal = (n: number): Proposal => proposal(n, { ty: 'Meta', c: '' });

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
        '| Osaka | 23 | 2025-12-03 | [EIP-7892] <br> [EIP-7918] | [Hardfork Meta EIP-7607](https://eips.ethereum.org/EIPS/eip-7607) | blog |',
        '| Prague | 22 | 2025-05-07 | [EIP-7702] | [Hardfork Meta EIP-7600](https://eips.ethereum.org/EIPS/eip-7600) | blog |',
        '| Cancun | 19 | 2024-03-13<br />(1710338135) | [EIP-4844](example) | [Hardfork Meta EIP-7569](https://eips.ethereum.org/EIPS/eip-7569) | blog |',
        '| Petersburg | 7 | 2019-02-28 | [EIP-145](example) | [Hardfork Meta EIP-1716](https://eips.ethereum.org/EIPS/eip-1716) | blog |',
        '| Constantinople | 7 | 2019-02-28 | [EIP-145](example) | [Hardfork Meta EIP-1013](https://eips.ethereum.org/EIPS/eip-1013) | blog |',
        '| Frontier | 1 | 2015-07-30 | | spec | blog |',
      ]),
    );

    expect(parsed.map(({ proposal, name, status, meta }) => ({ proposal, name, status, meta }))).toEqual([
      { proposal: 7892, name: 'Fusaka', status: 'included', meta: 7607 },
      { proposal: 7918, name: 'Fusaka', status: 'included', meta: 7607 },
      { proposal: 7702, name: 'Pectra', status: 'included', meta: 7600 },
      { proposal: 4844, name: 'Dencun', status: 'included', meta: 7569 },
      { proposal: 145, name: 'Petersburg', status: 'included', meta: 1716 },
      { proposal: 145, name: 'Constantinople', status: 'included', meta: 1013 },
    ]);
    expect(parsed.some((item) => item.proposal === 9999)).toBe(false);
  });

  it('fails on table schema drift and duplicate relationships', () => {
    expect(() => parseEelsProtocolHistory('# Protocol History')).toThrow('missing mainnet');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory([
          '| London | 12 | 2021-08-05 | [EIP-1559] <br> [EIP-1559] | [Hardfork Meta EIP-7568](https://eips.ethereum.org/EIPS/eip-7568) | blog |',
        ]),
      ),
    ).toThrow('duplicate relationship');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory(['| London | 12 | 2021-08-05 | [EIP-1559] <br> EIP-TBD | [Hardfork Meta EIP-7568](https://eips.ethereum.org/EIPS/eip-7568) | blog |']),
      ),
    ).toThrow('invalid included EIP-TBD');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory(['| London | 12 | 2021-08-05 | [EIP-0] | [Hardfork Meta EIP-7568](https://eips.ethereum.org/EIPS/eip-7568) | blog |']),
      ),
    ).toThrow('invalid included EIP-0');
  });

  it('uses the one active Meta EIP link and rejects missing or mismatched links', () => {
    const berlin = parseEelsProtocolHistory(
      eelsHistory([
        '| Berlin | 12 | 2021-04-15 | [EIP-2929] | ~[Hardfork Meta EIP-2070](https://eips.ethereum.org/EIPS/eip-2070)~ <br> [(Backfill) Meta EIP-7568](https://eips.ethereum.org/EIPS/eip-7568) | blog |',
      ]),
    );
    expect(berlin[0]?.meta).toBe(7568);
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory(['| London | 12 | 2021-08-05 | [EIP-1559] | spec | blog |']),
      ),
    ).toThrow('exactly one active hardfork Meta EIP');
    expect(() =>
      parseEelsProtocolHistory(
        eelsHistory([
          '| London | 12 | 2021-08-05 | [EIP-1559] | [Hardfork Meta EIP-7568](https://eips.ethereum.org/EIPS/eip-7569) | blog |',
        ]),
      ),
    ).toThrow('invalid hardfork Meta EIP');
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
      { proposal: 7708, name: 'Glamsterdam', status: 'scheduled', meta: 7773 },
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
    ).toThrow('no metadata is known');
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
      expect.objectContaining({ proposal: 7892, name: 'BPO2', status: 'included', meta: 8135 }),
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
        [eip, erc, metaProposal(7607), metaProposal(8134), metaProposal(8135), metaProposal(7773)],
        [
          relationship(7892, 'BPO2', 'included', 30, 'BPO Meta EIP-8135'),
          relationship(7892, 'Fusaka', 'included', 10),
          relationship(7892, 'BPO1', 'included', 20, 'BPO Meta EIP-8134'),
          relationship(7892, 'Glamsterdam', 'scheduled', 1),
        ],
      ),
    ).toEqual([]);
    expect(eip.u).toEqual([
      { n: 'Fusaka', s: 'included', m: 7607 },
      { n: 'BPO1', s: 'included', m: 8134 },
      { n: 'BPO2', s: 'included', m: 8135 },
      { n: 'Glamsterdam', s: 'scheduled', m: 7773 },
    ]);
    expect(erc.u).toBeUndefined();
  });

  it('does not resolve authoritative membership through a curated alias', () => {
    const canonical = proposal(8361);
    const aliased = proposal(8363, { aka: [8361] });
    expect(
      attachUpgradeRelationships(
        [canonical, aliased, metaProposal(7773)],
        [relationship(8361, 'Glamsterdam', 'scheduled', 1)],
      ),
    ).toEqual([]);
    expect(canonical.u).toEqual([{ n: 'Glamsterdam', s: 'scheduled', m: 7773 }]);
    expect(aliased.u).toBeUndefined();
  });

  it('reports missing and ambiguous referenced EIPs without partially attaching', () => {
    const first = proposal(7708);
    const rival = proposal(7708, { pr: 123 });
    const errors = attachUpgradeRelationships(
      [first, rival, metaProposal(7773), metaProposal(8081)],
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

  it('requires every upgrade link target to be a unique merged Meta EIP', () => {
    for (const invalidMeta of [
      [] as Proposal[],
      [proposal(7773)],
      [metaProposal(7773), proposal(7773, { ty: 'Meta', c: '', pr: 123 })],
      [proposal(7773, { ty: 'Meta', c: '', pr: 123 })],
    ]) {
      const eip = proposal(7708);
      const errors = attachUpgradeRelationships(
        [eip, ...invalidMeta],
        [relationship(7708, 'Glamsterdam', 'scheduled', 1)],
      );
      expect(errors).toHaveLength(1);
      expect(eip.u).toBeUndefined();
    }
  });
});
