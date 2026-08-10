import { describe, expect, it } from 'vitest';
import { findMatches } from '../src/core/match';
import { bareNumbersAllowedOn, hostListCovers, isSiteEnabled } from '../src/core/settings';
import { VALID_NUMBERS } from '../src/core/numbers.generated';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';

const valid = new Set(VALID_NUMBERS);
const isValid = (n: number) => valid.has(n);

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe('hostListCovers', () => {
  it('matches the host itself', () => {
    expect(hostListCovers(['example.com'], 'example.com')).toBe(true);
  });

  it('matches subdomains', () => {
    expect(hostListCovers(['example.com'], 'news.example.com')).toBe(true);
  });

  it('ignores a www. prefix on the page', () => {
    expect(hostListCovers(['example.com'], 'www.example.com')).toBe(true);
  });

  it('is not fooled by a lookalike host', () => {
    expect(hostListCovers(['example.com'], 'example.com.evil.net')).toBe(false);
  });

  it('is empty-safe, which is the default', () => {
    expect(hostListCovers([], 'example.com')).toBe(false);
  });
});

describe('the bare-number site blacklist', () => {
  it('is empty by default', () => {
    expect(DEFAULT_SETTINGS.bareNumberBlockedSites).toEqual([]);
    expect(DEFAULT_SETTINGS.bareNumbers).toBe(false);
    expect(DEFAULT_SETTINGS.predictEthBlocks).toBe(false);
  });

  it('blocks bare numbers on a listed host, and on its subdomains', () => {
    const s = settings({ bareNumbers: true, bareNumberBlockedSites: ['example.com'] });
    expect(bareNumbersAllowedOn(s, 'example.com')).toBe(false);
    expect(bareNumbersAllowedOn(s, 'news.example.com')).toBe(false);
    expect(bareNumbersAllowedOn(s, 'elsewhere.org')).toBe(true);
  });

  it('does nothing while bare numbers are off', () => {
    const s = settings({ bareNumbers: false, bareNumberBlockedSites: ['example.com'] });
    expect(bareNumbersAllowedOn(s, 'elsewhere.org')).toBe(false);
  });

  // The distinction from `disabledSites`, which stops the whole extension.
  it('leaves prefixed references matching on a listed host', () => {
    const s = settings({ bareNumbers: true, bareNumberBlockedSites: ['example.com'] });
    const text = 'EIP-7702 shipped; 4337 bundlers still matter.';
    const found = (host: string) =>
      findMatches(text, { isValid, allowBare: bareNumbersAllowedOn(s, host) }).map((m) => m.n);

    expect(found('example.com')).toEqual([7702]);
    expect(found('elsewhere.org')).toEqual([7702, 4337]);
    // The extension itself is untouched: only the guessing stops.
    expect(isSiteEnabled(s, 'example.com')).toBe(true);
  });

  it('is independent of the disabled-sites list', () => {
    const s = settings({ disabledSites: ['off.example'], bareNumberBlockedSites: ['noisy.example'] });
    expect(isSiteEnabled(s, 'off.example')).toBe(false);
    expect(isSiteEnabled(s, 'noisy.example')).toBe(true);
  });
});
