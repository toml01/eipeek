import type { Proposal } from '../core/types';

export interface UpgradeRow {
  label: 'Upgrade:' | 'Upgrades:';
  value: string;
}

/** Formats upgrade membership for the tooltip without changing dataset order. */
export function formatUpgradeRow(upgrades: Proposal['u']): UpgradeRow | null {
  if (!upgrades?.length) return null;

  return {
    label: upgrades.length === 1 ? 'Upgrade:' : 'Upgrades:',
    value: upgrades
      .map(({ n, s }) => (s === 'scheduled' ? `${n} (scheduled)` : n))
      .join(', '),
  };
}
