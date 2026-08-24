export interface AccessControlledStorageArea {
  setAccessLevel?: (options: {
    accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }) => Promise<void>;
}

export interface DatabaseStorageAreas {
  local: AccessControlledStorageArea;
  session?: AccessControlledStorageArea;
}

/**
 * Establishes the database trust boundary before any persistent read or write.
 * Fail closed on an incompatible browser: using local storage with its default
 * content-script exposure would broadcast complete signed artifacts.
 */
export async function configureDatabaseStorageAccess(storage: DatabaseStorageAreas): Promise<void> {
  if (
    typeof storage.local.setAccessLevel !== 'function' ||
    !storage.session ||
    typeof storage.session.setAccessLevel !== 'function'
  ) {
    throw new Error('Secure database storage access levels are unavailable');
  }
  await Promise.all([
    storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }),
  ]);
}
