import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_AUTO_UPDATE_STORAGE_KEY,
  DATABASE_DAILY_PERIOD_MINUTES,
  DatabaseAlarmScheduler,
  type DatabaseAlarm,
  type DatabaseAlarmStatus,
} from '../src/core/database-alarm';
import { DatabaseManagerError } from '../src/core/database-manager';
import {
  autoUpdateToggleView,
  type DatabaseManagerActionResponse,
  type DatabaseManagerStatus,
} from '../src/core/database-messages';
import {
  DatabaseRuntime,
  type DatabaseRuntimeManager,
  type DatabaseRuntimeRequest,
} from '../src/core/database-runtime';

class AlarmApi {
  alarm: DatabaseAlarm | undefined;
  getFails = 0;

  create = vi.fn((name: string, info: { delayInMinutes: number; periodInMinutes: number }) => {
    this.alarm = {
      name,
      scheduledTime: Date.parse('2026-08-25T00:00:00.000Z'),
      periodInMinutes: info.periodInMinutes,
    };
  });

  clear = vi.fn(async (name: string) => {
    const existed = this.alarm?.name === name;
    if (existed) this.alarm = undefined;
    return existed;
  });

  async get(name: string) {
    if (this.getFails > 0) {
      this.getFails -= 1;
      throw new Error('alarms.get failed');
    }
    return this.alarm?.name === name ? structuredClone(this.alarm) : undefined;
  }
}

class SyncStorage {
  values: Record<string, unknown> = {};
  getFails = 0;

  async get(keys: string[]) {
    if (this.getFails > 0) {
      this.getFails -= 1;
      throw new Error('storage.sync.get failed');
    }
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }

  async set(values: Record<string, unknown>) {
    Object.assign(this.values, values);
  }
}

function managerStatus(patch: Partial<DatabaseManagerStatus> = {}): DatabaseManagerStatus {
  return {
    source: 'bundled',
    activeVersion: 2,
    bundledVersion: 1,
    highWaterVersion: 2,
    revision: 3,
    proposalCount: 4,
    mergedNumberCount: 5,
    unmergedNumberCount: 6,
    activatedAt: '2026-08-24T12:00:00.000Z',
    downloadedAt: '2026-08-24T11:00:00.000Z',
    lastCheckedAt: '2026-08-24T12:34:56.000Z',
    lastCheckOutcome: 'current',
    lastCheckMessage: 'Database 2 is already active.',
    busy: false,
    ...patch,
  };
}

function action(
  outcome: DatabaseManagerActionResponse['outcome'],
  status = managerStatus(),
): DatabaseManagerActionResponse {
  return {
    ok: true,
    outcome,
    message:
      outcome === 'restored'
        ? 'Restored bundled database 1.'
        : outcome === 'activated'
          ? 'Verified and activated database 2.'
          : 'Database 2 is already active.',
    status,
  };
}

function managerStub(overrides: Partial<DatabaseRuntimeManager> = {}): DatabaseRuntimeManager & {
  check: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn(async () => managerStatus());
  const check = vi.fn(async () => action('current'));
  const restore = vi.fn(async () => action('restored', managerStatus({ source: 'bundled', lastCheckOutcome: 'current' })));
  return {
    status,
    checkForUpdates: check,
    restoreBundled: restore,
    check,
    restore,
    ...overrides,
  };
}

function daily(alarms = new AlarmApi(), storage = new SyncStorage()) {
  return new DatabaseAlarmScheduler({
    alarms,
    storage,
    random: () => 0,
    now: () => new Date('2026-08-24T00:00:00Z'),
  });
}

async function dispatch(runtime: DatabaseRuntime, request: DatabaseRuntimeRequest) {
  try {
    return await runtime.handle(request);
  } catch (error) {
    return runtime.errorResponse(error);
  }
}

describe('database runtime actions', () => {
  it('keeps a successful check when the later scheduler status read fails', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const scheduler = daily(alarms, storage);
    const manager = managerStub();
    const runtime = new DatabaseRuntime(manager, scheduler);
    runtime.rememberSchedule(await scheduler.reconcile());

    alarms.getFails = 1;
    const response = await dispatch(runtime, { type: 'database.check' });

    expect(manager.check).toHaveBeenCalledWith('manual');
    expect(response).toMatchObject({
      ok: true,
      outcome: 'current',
      message: 'Database 2 is already active.',
      status: {
        ...managerStatus(),
        autoUpdateEnabled: true,
        nextScheduledCheckAt: '2026-08-25T00:00:00.000Z',
      },
    });
    expect(alarms.getFails).toBe(0);
  });

  it('keeps a successful restore and the last-known disabled schedule', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const scheduler = daily(alarms, storage);
    const manager = managerStub();
    const runtime = new DatabaseRuntime(manager, scheduler);
    const disabled = await scheduler.setEnabled(false);
    runtime.rememberSchedule(disabled);

    storage.getFails = 1;
    const response = await dispatch(runtime, { type: 'database.restore' });

    expect(manager.restore).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      outcome: 'restored',
      message: 'Restored bundled database 1.',
      status: {
        ...managerStatus({ source: 'bundled', lastCheckOutcome: 'current' }),
        autoUpdateEnabled: false,
        nextScheduledCheckAt: null,
      },
    });
    expect(disabled).toEqual({ autoUpdateEnabled: false, nextScheduledCheckAt: null });
  });

  it('uses the setEnabled snapshot and does not reread scheduler status after a toggle', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const inner = daily(alarms, storage);
    await inner.reconcile();
    const status = vi.fn(async (): Promise<DatabaseAlarmStatus> => {
      throw new Error('scheduler.status should not run after setEnabled');
    });
    const scheduler = {
      status,
      setEnabled: (enabled: boolean) => inner.setEnabled(enabled),
    };
    const manager = managerStub();
    const runtime = new DatabaseRuntime(manager, scheduler);

    const response = await dispatch(runtime, { type: 'database.setAutoUpdate', enabled: false });

    expect(status).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: true,
      status: {
        ...managerStatus(),
        autoUpdateEnabled: false,
        nextScheduledCheckAt: null,
      },
    });
    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(false);
    expect(autoUpdateToggleView(false, response)).toEqual({
      checked: false,
      nextCheck: 'Disabled',
      applyReturnedStatus: true,
    });
  });

  it('keeps a successful enable even if a later status read would fail', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    const inner = daily(alarms, storage);
    let allowStatus = false;
    const scheduler = {
      async status() {
        if (!allowStatus) throw new Error('storage.sync.get failed');
        return inner.status();
      },
      setEnabled: (enabled: boolean) => inner.setEnabled(enabled),
    };
    const runtime = new DatabaseRuntime(managerStub(), scheduler);

    const response = await dispatch(runtime, { type: 'database.setAutoUpdate', enabled: true });

    expect(response).toMatchObject({
      ok: true,
      status: {
        autoUpdateEnabled: true,
        nextScheduledCheckAt: '2026-08-25T00:00:00.000Z',
      },
    });
    expect(alarms.alarm?.periodInMinutes).toBe(DATABASE_DAILY_PERIOD_MINUTES);
    expect(autoUpdateToggleView(true, response)).toEqual({
      checked: true,
      nextCheck: 'scheduled',
      applyReturnedStatus: true,
    });

    allowStatus = false;
    const check = await dispatch(runtime, { type: 'database.check' });
    expect(check).toMatchObject({
      ok: true,
      status: {
        autoUpdateEnabled: true,
        nextScheduledCheckAt: '2026-08-25T00:00:00.000Z',
      },
    });
  });

  it('still fails a genuine check and includes authoritative schedule status', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const scheduler = daily(alarms, storage);
    const runtime = new DatabaseRuntime(
      managerStub({
        checkForUpdates: async () => {
          throw new DatabaseManagerError('network', 'The database action failed.');
        },
      }),
      scheduler,
    );
    runtime.rememberSchedule(await scheduler.reconcile());

    const response = await dispatch(runtime, { type: 'database.check' });

    expect(response).toEqual({
      ok: false,
      code: 'network',
      message: 'The database action failed.',
      status: {
        ...managerStatus(),
        autoUpdateEnabled: true,
        nextScheduledCheckAt: '2026-08-25T00:00:00.000Z',
      },
    });
  });

  it('still fails alarm reconciliation and reports the persisted enable', async () => {
    const alarms = new AlarmApi();
    alarms.create = vi.fn(() => {
      throw new Error('create failed');
    });
    const storage = new SyncStorage();
    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    const scheduler = daily(alarms, storage);
    const runtime = new DatabaseRuntime(managerStub(), scheduler);

    const response = await dispatch(runtime, { type: 'database.setAutoUpdate', enabled: true });

    expect(response).toMatchObject({
      ok: false,
      code: 'network',
      message: 'The database action failed.',
      status: {
        autoUpdateEnabled: true,
        nextScheduledCheckAt: null,
      },
    });
    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(true);
    expect(alarms.alarm).toBeUndefined();
    expect(autoUpdateToggleView(true, response)).toEqual({
      checked: true,
      nextCheck: 'Scheduling…',
      applyReturnedStatus: true,
    });
  });

  it('lets a status-only read fail without inventing a successful mutation', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const scheduler = daily(alarms, storage);
    const runtime = new DatabaseRuntime(managerStub(), scheduler);
    runtime.rememberSchedule(await scheduler.reconcile());
    alarms.get = async () => {
      throw new Error('alarms.get failed');
    };

    const response = await dispatch(runtime, { type: 'database.status' });

    expect(response).toEqual({
      ok: false,
      code: 'network',
      message: 'The database action failed.',
    });
  });
});
