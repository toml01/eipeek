import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from './types';

export async function getSettings(): Promise<Settings> {
  try {
    // Passing the defaults as the query fills in any key never written.
    const stored = await browser.storage.sync.get(
      DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    );
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  } catch {
    // Storage can be unavailable while the extension is reloading; the
    // defaults are the safe answer (bare numbers off).
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.sync.set(patch);
}

/**
 * Whether a hostname is covered by a user-written site list.
 *
 * Shared by both site lists on purpose: `disabledSites` and
 * `bareNumberBlockedSites` are written into identical textareas, so entering
 * `example.com` has to mean the same thing in each -- the host itself, its
 * subdomains, and `www.` either way.
 */
export function hostListCovers(list: readonly string[], hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isSiteEnabled(s: Settings, hostname: string): boolean {
  if (!s.enabled) return false;
  return !hostListCovers(s.disabledSites, hostname);
}

/**
 * Whether Tier 2 is available on this host at all. Separate from
 * `isSiteEnabled`, because a site on the bare-number blacklist keeps its
 * prefixed references highlighted -- only the guessing stops.
 */
export function bareNumbersAllowedOn(s: Settings, hostname: string): boolean {
  return s.bareNumbers && !hostListCovers(s.bareNumberBlockedSites, hostname);
}

export function onSettingsChanged(fn: (s: Settings) => void): void {
  const settingKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => settingKeys.has(key))) {
      void getSettings().then(fn);
    }
  });
}
