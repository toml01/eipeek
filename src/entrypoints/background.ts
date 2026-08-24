import proposals from '../../data/eips.json';
import { BUNDLED_DATABASE_PAYLOAD_SHA256, BUNDLED_DATABASE_VERSION } from '../core/database.generated';
import { DatabaseManager } from '../core/database-manager';
import {
  DATABASE_AUTO_UPDATE_STORAGE_KEY,
  DatabaseAlarmScheduler,
  type DatabaseAlarm,
} from '../core/database-alarm';
import { DatabaseRuntime } from '../core/database-runtime';
import { constructDatabasePayload } from '../core/database-payload';
import { configureDatabaseStorageAccess } from '../core/database-storage-access';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../core/numbers.generated';
import type { Proposal } from '../core/types';
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
  // Attempt this before any persistent operation. On Chrome versions where the
  // access-level API is absent or rejects, the adapters below never touch that
  // storage area; bundled lookups remain available without weakening isolation.
  const storageAccess = configureDatabaseStorageAccess(chromeApi.storage);
  const payload = constructDatabasePayload({
    databaseVersion: BUNDLED_DATABASE_VERSION,
    proposals: proposals as Proposal[],
    mergedNumbers: VALID_NUMBERS,
    unmergedNumbers: UNMERGED_NUMBERS,
  });

  const manager = new DatabaseManager({
    storage: {
      get: async (keys) => {
        if (!(await storageAccess).local) throw new Error('trusted local storage unavailable');
        return chromeApi.storage.local.get(keys);
      },
      set: async (values) => {
        if (!(await storageAccess).local) throw new Error('trusted local storage unavailable');
        return chromeApi.storage.local.set(values);
      },
    },
    bundledPayload: payload,
    bundledPayloadDigest: BUNDLED_DATABASE_PAYLOAD_SHA256,
    notifyActivation: async (signal) => {
      if (!(await storageAccess).session || !chromeApi.storage.session) {
        throw new Error('untrusted session activation channel unavailable');
      }
      await chromeApi.storage.session.set({ [DATABASE_ACTIVATION_STORAGE_KEY]: signal });
    },
    notifyStatusChange: publishUiChange,
  });

  let uiChangeRevision = Date.now();
  async function publishUiChange() {
    if (!(await storageAccess).session || !chromeApi.storage.session) {
      throw new Error('untrusted session status channel unavailable');
    }
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
  const runtime = new DatabaseRuntime(manager, scheduler);

  const reconcileSchedule = () => {
    void runtime.reconcileSchedule().catch(() => {});
  };

  // Lifecycle and alarm listeners are registered synchronously at worker
  // evaluation. Reconciliation only touches storage/alarms and never fetches.
  chromeApi.alarms.onAlarm.addListener((alarm) => {
    void scheduler.handleAlarm(alarm, () => manager.checkForUpdates('automatic')).catch(() => {});
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
  // manual check or delivery of the matching daily alarm below.
  void Promise.all([
    manager.initialize(),
    runtime.reconcileSchedule(),
  ]).catch(() => {});

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
      switch (request.type) {
        case 'lookup':
          return manager.lookup(request.numbers, request.revision);
        case 'database.getIndex':
          return manager.getNumberIndex();
        case 'database.status':
        case 'database.check':
        case 'database.restore':
        case 'database.setAutoUpdate':
          return runtime.handle(request);
      }
    };

    void respond().then(sendResponse, async (error: unknown) => {
      sendResponse(await runtime.errorResponse(error));
    });

    // Chrome ignores a returned Promise from MV3 onMessage. Keep the channel
    // open explicitly for every recognized asynchronous request.
    return true;
  });
});
