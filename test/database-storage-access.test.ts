import { describe, expect, it, vi } from 'vitest';
import { configureDatabaseStorageAccess } from '../src/core/database-storage-access';

describe('database storage trust boundary', () => {
  it('hides local storage and exposes only session storage to content scripts', async () => {
    const local = vi.fn(async () => {});
    const session = vi.fn(async () => {});

    await expect(configureDatabaseStorageAccess({
      local: { setAccessLevel: local },
      session: { setAccessLevel: session },
    })).resolves.toEqual({ local: true, session: true });

    expect(local).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  });

  it('reports unsupported APIs without throwing so bundled operation can continue', async () => {
    await expect(configureDatabaseStorageAccess({ local: {}, session: {} })).resolves.toEqual({
      local: false,
      session: false,
    });
  });

  it('fails each rejected access boundary closed while preserving supported boundaries', async () => {
    const rejected = vi.fn(async () => {
      throw new Error('not supported by this Chrome version');
    });
    const supported = vi.fn(async () => {});

    await expect(
      configureDatabaseStorageAccess({
        local: { setAccessLevel: rejected },
        session: { setAccessLevel: supported },
      }),
    ).resolves.toEqual({ local: false, session: true });
    await expect(
      configureDatabaseStorageAccess({
        local: { setAccessLevel: supported },
        session: { setAccessLevel: rejected },
      }),
    ).resolves.toEqual({ local: true, session: false });
  });
});
