import { describe, expect, it } from 'vitest';
import {
  DATABASE_ACTIVATION_STORAGE_KEY,
  isDatabaseActivationChange,
  isExtensionPageSender,
  parseRuntimeRequest,
} from '../src/core/database-messages';

describe('database runtime messages', () => {
  it('accepts only fixed database actions with no caller-controlled URL', () => {
    expect(parseRuntimeRequest({ type: 'database.check' })).toEqual({ type: 'database.check' });
    expect(parseRuntimeRequest({ type: 'database.restore' })).toEqual({ type: 'database.restore' });
    expect(
      parseRuntimeRequest({ type: 'database.check', url: 'https://attacker.example/database.json' }),
    ).toBeNull();
    expect(parseRuntimeRequest({ type: 'database.status', extra: true })).toBeNull();
  });

  it('bounds and validates versioned lookup requests', () => {
    expect(parseRuntimeRequest({ type: 'lookup', numbers: [1, 7702], revision: 4 })).toEqual({
      type: 'lookup',
      numbers: [1, 7702],
      revision: 4,
    });
    expect(parseRuntimeRequest({ type: 'lookup', numbers: [0], revision: 4 })).toBeNull();
    expect(parseRuntimeRequest({ type: 'lookup', numbers: [1], revision: -1 })).toBeNull();
    expect(parseRuntimeRequest({ type: 'lookup', numbers: [1], revision: 0, url: 'https://x' })).toBeNull();
  });

  it('restricts mutation actions to extension pages, not content-script senders', () => {
    const root = 'chrome-extension://abcdefghijklmnop/';
    expect(isExtensionPageSender({ url: `${root}popup.html` }, root)).toBe(true);
    expect(isExtensionPageSender({ url: `${root}options.html` }, root)).toBe(true);
    expect(isExtensionPageSender({ url: `${root}options.html`, tab: {} }, root)).toBe(true);
    expect(isExtensionPageSender({ url: 'https://example.com/', tab: {} }, root)).toBe(false);
    expect(isExtensionPageSender({ url: `chrome-extension://different-id/options.html` }, root)).toBe(false);
  });

  it('accepts only the small storage.session activation signal', () => {
    expect(
      isDatabaseActivationChange(
        { [DATABASE_ACTIVATION_STORAGE_KEY]: { newValue: { revision: 7 } } },
        'session',
      ),
    ).toBe(true);
    expect(
      isDatabaseActivationChange(
        { 'eipeek.database.slot.0.v1': { newValue: { envelope: 'large artifact' } } },
        'local',
      ),
    ).toBe(false);
    expect(
      isDatabaseActivationChange(
        { [DATABASE_ACTIVATION_STORAGE_KEY]: { newValue: { revision: 7, payload: 'forbidden' } } },
        'session',
      ),
    ).toBe(false);
    expect(
      isDatabaseActivationChange(
        { [DATABASE_ACTIVATION_STORAGE_KEY]: { newValue: { revision: -1 } } },
        'session',
      ),
    ).toBe(false);
  });
});
