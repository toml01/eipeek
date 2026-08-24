import bundledPayload from '../../data/database.payload.json';
import { BUNDLED_DATABASE_PAYLOAD_SHA256, BUNDLED_DATABASE_VERSION } from '../core/database.generated';
import type { DatabasePayload } from '../core/database-artifact';
import { DatabaseManager, DatabaseManagerError } from '../core/database-manager';
import {
  DATABASE_AUTO_UPDATE_STORAGE_KEY,
  DatabaseAlarmScheduler,
  type DatabaseAlarm,
} from '../core/database-alarm';
import { configureDatabaseStorageAccess } from '../core/database-storage-access';
import {
  DATABASE_ACTIVATION_STORAGE_KEY,
  DATABASE_UI_CHANGE_STORAGE_KEY,
  isDatabaseMutationRequest,
  isExtensionPageSender,
  parseRuntimeRequest,
  type DatabaseErrorResponse,
} from '../core/database-messages';

// Using Chrome's global directly keeps WXT's optional storage helper (and its
// multiline diagnostics) out of the already-large, minified database worker.
// This is the subset used here; WXT still supplies the global at runtime.
const chromeApi = (globalThis as typeof globalThis & {
  chrome: {
    storage: {
      local: {
        get(keys: string[]): Promise<Record<string, unknown>>;
        set(values: Record<string, unknown>): Promise<void>;
        setAccessLevel?(options: {
          accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
        }): Promise<void>;
      };
      sync: {
        get(keys: string[]): Promise<Record<string, unknown>>;
        set(values: Record<string, unknown>): Promise<void>;
      };
      session?: {
        set(values: Record<string, unknown>): Promise<void>;
        setAccessLevel?(options: {
          accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
        }): Promise<void>;
      };
      onChanged: {
        addListener(
          listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
        ): void;
      };
    };
    alarms: {
      get(name: string): Promise<DatabaseAlarm | undefined>;
      create(name: string, info: { delayInMinutes: number; periodInMinutes: number }): void;
      clear(name: string): Promise<boolean>;
      onAlarm: { addListener(listener: (alarm: DatabaseAlarm) => void): void };
    };
    runtime: {
      getURL(path: string): string;
      onMessage: {
        addListener(
          listener: (
            message: unknown,
            sender: { url?: string; tab?: unknown },
            sendResponse: (response: unknown) => void,
          ) => boolean,
        ): void;
      };
      onInstalled: { addListener(listener: () => void): void };
      onStartup: { addListener(listener: () => void): void };
    };
  };
}).chrome;

/**
 * Holds the bundled fallback or a verified downloaded database and answers
 * number-index and metadata requests. The full payload stays in the worker;
 * content scripts receive only precomputed number arrays and requested records.
 */
export default defineBackground(() => {
  // Do this before initialization or any message can reach persistent storage.
  // local holds large signed artifacts and is trusted-only; session exposes only
  // the tiny revision signal used to wake existing content scripts/settings UIs.
  const storageReady = configureDatabaseStorageAccess(chromeApi.storage).catch(() => {
    throw new DatabaseManagerError('storage', 'Secure database storage is unavailable in this browser.');
  });
  const payload = bundledPayload as DatabasePayload;
  if (payload.databaseVersion !== BUNDLED_DATABASE_VERSION) {
    throw new Error('Bundled database payload/version mismatch');
  }

  const manager = new DatabaseManager({
    storage: {
      get: async (keys) => chromeApi.storage.local.get(keys),
      set: async (values) => chromeApi.storage.local.set(values),
    },
    bundledPayload: payload,
    bundledPayloadDigest: BUNDLED_DATABASE_PAYLOAD_SHA256,
    notifyActivation: async (signal) => {
      if (!chromeApi.storage.session) throw new Error('storage.session unavailable');
      await chromeApi.storage.session.set({ [DATABASE_ACTIVATION_STORAGE_KEY]: signal });
    },
    notifyStatusChange: publishUiChange,
  });

  let uiChangeRevision = Date.now();
  async function publishUiChange() {
    if (!chromeApi.storage.session) throw new Error('storage.session unavailable');
    uiChangeRevision = uiChangeRevision >= Number.MAX_SAFE_INTEGER ? Date.now() : uiChangeRevision + 1;
    await chromeApi.storage.session.set({
      [DATABASE_UI_CHANGE_STORAGE_KEY]: { revision: uiChangeRevision },
    });
  }

  const scheduler = new DatabaseAlarmScheduler({
    alarms: chromeApi.alarms,
    storage: chromeApi.storage.sync,
    notifyChange: publishUiChange,
  });

  const reconcileSchedule = () => {
    void storageReady.then(() => scheduler.reconcile()).catch(() => {});
  };

  // Lifecycle and alarm listeners are registered synchronously at worker
  // evaluation. Reconciliation only touches storage/alarms and never fetches.
  chromeApi.alarms.onAlarm.addListener((alarm) => {
    void storageReady
      .then(() => scheduler.handleAlarm(alarm, () => manager.checkForUpdates('automatic')))
      .catch(() => {});
  });
  chromeApi.runtime.onInstalled.addListener(reconcileSchedule);
  chromeApi.runtime.onStartup.addListener(reconcileSchedule);
  chromeApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && Object.hasOwn(changes, DATABASE_AUTO_UPDATE_STORAGE_KEY)) {
      reconcileSchedule();
    }
  });

  // Reverify persisted downloaded bytes after every worker start. Initialization
  // reads local storage only and never calls fetch; network is exclusive to the
  // a manual check or delivery of the matching daily alarm below.
  void storageReady
    .then(() => Promise.all([manager.initialize(), scheduler.reconcile()]))
    .catch(() => {});

  const combinedStatus = async () => ({
    ...(await manager.status()),
    ...(await scheduler.status()),
  });

  const combineActionStatus = async <T extends { status: unknown }>(response: T) => ({
    ...response,
    status: await combinedStatus(),
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const request = parseRuntimeRequest(message);
    if (!request) return false;

    if (
      isDatabaseMutationRequest(request) &&
      !isExtensionPageSender(sender, chromeApi.runtime.getURL(''))
    ) {
      sendResponse({
        ok: false,
        code: 'forbidden',
        message: 'Database actions are available only from an extension settings page.',
      } satisfies DatabaseErrorResponse);
      return true;
    }

    const respond = async () => {
      await storageReady;
      switch (request.type) {
        case 'lookup':
          return manager.lookup(request.numbers, request.revision);
        case 'database.getIndex':
          return manager.getNumberIndex();
        case 'database.status':
          return { ok: true as const, status: await combinedStatus() };
        case 'database.check':
          return combineActionStatus(await manager.checkForUpdates('manual'));
        case 'database.restore':
          return combineActionStatus(await manager.restoreBundled());
        case 'database.setAutoUpdate':
          await scheduler.setEnabled(request.enabled);
          return { ok: true as const, status: await combinedStatus() };
      }
    };

    void respond().then(sendResponse, async (error: unknown) => {
      const normalized =
        error instanceof DatabaseManagerError
          ? error
          : new DatabaseManagerError('network', 'The database action failed.');
      let status;
      try {
        await storageReady;
        status = await combinedStatus();
      } catch {
        // Never touch local storage when its trusted-only boundary could not be
        // established. The error response remains useful without status.
      }
      sendResponse({
        ok: false,
        code: normalized.code,
        message: normalized.message,
        ...(status ? { status } : {}),
      } satisfies DatabaseErrorResponse);
    });

    // Chrome ignores a returned Promise from MV3 onMessage. Keep the channel
    // open explicitly for every recognized asynchronous request.
    return true;
  });
});
