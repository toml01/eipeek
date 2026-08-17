import { describe, expect, it } from 'vitest';
import { formatUpgradeRow } from '../src/ui/upgrades';

describe('upgrade tooltip row', () => {
  it('is absent when the proposal has no upgrade membership', () => {
    expect(formatUpgradeRow(undefined)).toBeNull();
  });

  it('formats one included upgrade', () => {
    expect(formatUpgradeRow([{ n: 'Pectra', s: 'included' }])).toEqual({
      label: 'Upgrade:',
      value: 'Pectra',
    });
  });

  it('marks scheduled upgrades and preserves the supplied order', () => {
    expect(
      formatUpgradeRow([
        { n: 'Fusaka', s: 'included' },
        { n: 'BPO1', s: 'included' },
        { n: 'BPO2', s: 'included' },
        { n: 'Glamsterdam', s: 'scheduled' },
      ]),
    ).toEqual({
      label: 'Upgrades:',
      value: 'Fusaka, BPO1, BPO2, Glamsterdam (scheduled)',
    });
  });
});
