export interface AccessControlledStorageArea {
  setAccessLevel?: (options: {
    accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }) => Promise<void>;
}

export interface DatabaseStorageAreas {
  local: AccessControlledStorageArea;
  session?: AccessControlledStorageArea;
}

export interface DatabaseStorageAccess {
  /** Safe to use only after TRUSTED_CONTEXTS was confirmed. */
  local: boolean;
  /** Safe to use as the content-script-visible revision channel. */
  session: boolean;
}

/**
 * Attempts to establish each storage boundary before that area is used.
 * Chrome versions in the supported range can expose the method but reject its
 * promise. Callers must not touch an area reported as false; this preserves the
 * bundled database without exposing persistent artifacts under default access.
 */
export async function configureDatabaseStorageAccess(
  storage: DatabaseStorageAreas,
): Promise<DatabaseStorageAccess> {
  const [local, session] = await Promise.all([
    setAccessLevel(storage.local, 'TRUSTED_CONTEXTS'),
    storage.session
      ? setAccessLevel(storage.session, 'TRUSTED_AND_UNTRUSTED_CONTEXTS')
      : Promise.resolve(false),
  ]);
  return { local, session };
}

async function setAccessLevel(
  area: AccessControlledStorageArea,
  accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
): Promise<boolean> {
  if (typeof area.setAccessLevel !== 'function') return false;
  try {
    await area.setAccessLevel({ accessLevel });
    return true;
  } catch {
    return false;
  }
}
