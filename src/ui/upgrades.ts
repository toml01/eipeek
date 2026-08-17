import { specUrl } from '../core/links';
import type { Proposal } from '../core/types';

export interface UpgradeItem {
  name: string;
  status: 'included' | 'scheduled';
  url: string;
}

/** Prepares inline upgrade metadata without changing dataset order. */
export function formatUpgradeItems(upgrades: Proposal['u']): UpgradeItem[] {
  return (upgrades ?? []).map(({ n, s, m }) => ({
    name: n,
    status: s,
    url: specUrl(m),
  }));
}
