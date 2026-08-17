import { describe, expect, it } from 'vitest';
import { formatUpgradeItems } from '../src/ui/upgrades';

describe('inline tooltip upgrades', () => {
  it('is absent when the proposal has no upgrade membership', () => {
    expect(formatUpgradeItems(undefined)).toEqual([]);
  });

  it('links an upgrade through its Meta EIP', () => {
    expect(formatUpgradeItems([{ n: 'Pectra', s: 'included', m: 7600 }])).toEqual([
      {
        name: 'Pectra',
        status: 'included',
        url: 'https://eips.ethereum.org/EIPS/eip-7600',
      },
    ]);
  });

  it('preserves status and supplied order', () => {
    expect(
      formatUpgradeItems([
        { n: 'Fusaka', s: 'included', m: 7607 },
        { n: 'BPO1', s: 'included', m: 8134 },
        { n: 'Glamsterdam', s: 'scheduled', m: 7773 },
      ]),
    ).toEqual([
      {
        name: 'Fusaka',
        status: 'included',
        url: 'https://eips.ethereum.org/EIPS/eip-7607',
      },
      {
        name: 'BPO1',
        status: 'included',
        url: 'https://eips.ethereum.org/EIPS/eip-8134',
      },
      {
        name: 'Glamsterdam',
        status: 'scheduled',
        url: 'https://eips.ethereum.org/EIPS/eip-7773',
      },
    ]);
  });
});
