import { describe, expect, it, vi } from 'vitest';
import { configureDatabaseStorageAccess } from '../src/core/database-storage-access';

describe('database storage trust boundary', () => {
  it('hides local storage and exposes only session storage to content scripts', async () => {
    const local = vi.fn(async () => {});
    const session = vi.fn(async () => {});

    await configureDatabaseStorageAccess({
      local: { setAccessLevel: local },
      session: { setAccessLevel: session },
    });

    expect(local).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  });

  it('fails closed when either access-level API is unavailable', async () => {
    await expect(configureDatabaseStorageAccess({ local: {}, session: {} })).rejects.toThrow(
      'Secure database storage access levels are unavailable',
    );
  });
});
