import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_AUTO_UPDATE_STORAGE_KEY,
  DATABASE_DAILY_ALARM_NAME,
  DATABASE_DAILY_PERIOD_MINUTES,
  DatabaseAlarmScheduler,
  firstDelayMinutes,
  type DatabaseAlarm,
} from '../src/core/database-alarm';

class AlarmApi {
  alarm: DatabaseAlarm | undefined;
  getCalls = 0;
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
    this.getCalls += 1;
    return this.alarm?.name === name ? structuredClone(this.alarm) : undefined;
  }
}

class SyncStorage {
  values: Record<string, unknown> = {};
  async get(keys: string[]) {
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }
  async set(values: Record<string, unknown>) {
    Object.assign(this.values, values);
  }
}

class BlockingGetAlarmApi extends AlarmApi {
  readonly getStarted = deferred();
  readonly releaseGet = deferred();
  private blockNextGet = true;

  override async get(name: string) {
    if (this.blockNextGet) {
      this.blockNextGet = false;
      this.getStarted.resolve();
      await this.releaseGet.promise;
    }
    return super.get(name);
  }
}

class DelayedFirstSetStorage extends SyncStorage {
  readonly firstSetStarted = deferred();
  readonly releaseFirstSet = deferred();
  setCalls = 0;

  override async set(values: Record<string, unknown>) {
    this.setCalls += 1;
    if (this.setCalls === 1) {
      this.firstSetStarted.resolve();
      await this.releaseFirstSet.promise;
    }
    Object.assign(this.values, values);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scheduler(
  alarms: AlarmApi,
  storage: SyncStorage,
  random = () => 0.5,
  notifyChange: () => Promise<void> = async () => {},
) {
  return new DatabaseAlarmScheduler({
    alarms,
    storage,
    random,
    now: () => new Date('2026-08-24T00:00:00Z'),
    notifyChange,
  });
}

describe('daily database alarm', () => {
  it('defaults on and creates one daily alarm with a randomized first delay', async () => {
    const alarms = new AlarmApi();
    const status = await scheduler(alarms, new SyncStorage(), () => 0).reconcile();

    expect(alarms.create).toHaveBeenCalledWith(DATABASE_DAILY_ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: DATABASE_DAILY_PERIOD_MINUTES,
    });
    expect(status.autoUpdateEnabled).toBe(true);
    expect(status.nextScheduledCheckAt).toBe('2026-08-25T00:00:00.000Z');
  });

  it('keeps an existing correct alarm without re-randomizing', async () => {
    const alarms = new AlarmApi();
    alarms.alarm = {
      name: DATABASE_DAILY_ALARM_NAME,
      scheduledTime: Date.parse('2026-08-26T12:00:00Z'),
      periodInMinutes: DATABASE_DAILY_PERIOD_MINUTES,
    };

    await scheduler(alarms, new SyncStorage()).reconcile();

    expect(alarms.create).not.toHaveBeenCalled();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('serializes every concurrent lifecycle reconciliation without re-randomizing', async () => {
    const alarms = new AlarmApi();
    const notifyChange = vi.fn(async () => {});
    const daily = scheduler(alarms, new SyncStorage(), () => 0.5, notifyChange);

    await Promise.all([daily.reconcile(), daily.reconcile(), daily.reconcile()]);

    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(notifyChange).toHaveBeenCalledTimes(3);
  });

  it('applies an enable queued behind a blocked disabled reconciliation', async () => {
    const alarms = new BlockingGetAlarmApi();
    const storage = new SyncStorage();
    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    const daily = scheduler(alarms, storage);

    const reconciliation = daily.reconcile();
    await alarms.getStarted.promise;
    const enable = daily.setEnabled(true);

    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(false);
    alarms.releaseGet.resolve();
    await Promise.all([reconciliation, enable]);

    expect(await daily.status()).toEqual({
      autoUpdateEnabled: true,
      nextScheduledCheckAt: '2026-08-25T00:00:00.000Z',
    });
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it('applies a disable queued behind a blocked enabled reconciliation', async () => {
    const alarms = new BlockingGetAlarmApi();
    const storage = new SyncStorage();
    const daily = scheduler(alarms, storage);

    const reconciliation = daily.reconcile();
    await alarms.getStarted.promise;
    const disable = daily.setEnabled(false);

    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBeUndefined();
    alarms.releaseGet.resolve();
    await Promise.all([reconciliation, disable]);

    expect(await daily.status()).toEqual({ autoUpdateEnabled: false, nextScheduledCheckAt: null });
    expect(alarms.alarm).toBeUndefined();
  });

  it('queues lifecycle reconciliation behind an in-flight toggle', async () => {
    const alarms = new BlockingGetAlarmApi();
    const storage = new DelayedFirstSetStorage();
    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    const daily = scheduler(alarms, storage);

    const enable = daily.setEnabled(true);
    await storage.firstSetStarted.promise;
    const lifecycle = daily.reconcile();
    await nextTask();

    expect(alarms.getCalls).toBe(0);
    storage.releaseFirstSet.resolve();
    await alarms.getStarted.promise;
    alarms.releaseGet.resolve();
    await Promise.all([enable, lifecycle]);

    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(true);
    expect(alarms.alarm?.periodInMinutes).toBe(DATABASE_DAILY_PERIOD_MINUTES);
  });

  it('makes the last opposite change from two surfaces win', async () => {
    const alarms = new AlarmApi();
    const storage = new DelayedFirstSetStorage();
    const daily = scheduler(alarms, storage);

    const disable = daily.setEnabled(false);
    await storage.firstSetStarted.promise;
    const enable = daily.setEnabled(true);
    await nextTask();

    expect(storage.setCalls).toBe(1);
    storage.releaseFirstSet.resolve();
    await Promise.all([disable, enable]);

    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(true);
    expect(alarms.alarm?.periodInMinutes).toBe(DATABASE_DAILY_PERIOD_MINUTES);
  });

  it('waits public status reads for an already-queued toggle', async () => {
    const alarms = new AlarmApi();
    const storage = new DelayedFirstSetStorage();
    const daily = scheduler(alarms, storage);

    const disable = daily.setEnabled(false);
    await storage.firstSetStarted.promise;
    const status = daily.status();
    let statusSettled = false;
    void status.then(() => {
      statusSettled = true;
    });
    await nextTask();

    expect(statusSettled).toBe(false);
    storage.releaseFirstSet.resolve();
    await disable;
    expect(await status).toEqual({ autoUpdateEnabled: false, nextScheduledCheckAt: null });
  });

  it('replaces an incorrect alarm and clears the schedule when disabled', async () => {
    const alarms = new AlarmApi();
    alarms.alarm = { name: DATABASE_DAILY_ALARM_NAME, scheduledTime: 1, periodInMinutes: 60 };
    const storage = new SyncStorage();
    const daily = scheduler(alarms, storage);

    await daily.reconcile();
    expect(alarms.clear).toHaveBeenCalledWith(DATABASE_DAILY_ALARM_NAME);
    expect(alarms.create).toHaveBeenCalledTimes(1);

    const status = await daily.setEnabled(false);
    expect(storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY]).toBe(false);
    expect(status).toEqual({ autoUpdateEnabled: false, nextScheduledCheckAt: null });
    expect(alarms.alarm).toBeUndefined();
  });

  it('recreates the schedule when re-enabled', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    const daily = scheduler(alarms, storage, () => 0.999999);

    await daily.reconcile();
    expect(alarms.create).not.toHaveBeenCalled();
    await daily.setEnabled(true);

    expect(alarms.create).toHaveBeenCalledWith(DATABASE_DAILY_ALARM_NAME, {
      delayInMinutes: 1_440,
      periodInMinutes: 1_440,
    });
  });

  it('maps jitter to every minute in the inclusive 1..1440 range', () => {
    expect(firstDelayMinutes(0)).toBe(1);
    expect(firstDelayMinutes(1 / 1_440)).toBe(2);
    expect(firstDelayMinutes(0.5)).toBe(721);
    expect(firstDelayMinutes(0.999999999)).toBe(1_440);
    expect(firstDelayMinutes(1)).toBe(1_440);
    expect(firstDelayMinutes(Number.NaN)).toBe(1);
  });

  it('runs checks only for the matching alarm while enabled', async () => {
    const alarms = new AlarmApi();
    const storage = new SyncStorage();
    const daily = scheduler(alarms, storage);
    const check = vi.fn(async () => {});

    expect(await daily.handleAlarm({ name: 'other', scheduledTime: 1 }, check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(await daily.handleAlarm({ name: DATABASE_DAILY_ALARM_NAME, scheduledTime: 1 }, check)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);

    storage.values[DATABASE_AUTO_UPDATE_STORAGE_KEY] = false;
    expect(await daily.handleAlarm({ name: DATABASE_DAILY_ALARM_NAME, scheduledTime: 1 }, check)).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not start an alarm check behind a queued disable', async () => {
    const alarms = new AlarmApi();
    const storage = new DelayedFirstSetStorage();
    const daily = scheduler(alarms, storage);
    const check = vi.fn(async () => {});

    const disable = daily.setEnabled(false);
    await storage.firstSetStarted.promise;
    const handling = daily.handleAlarm(
      { name: DATABASE_DAILY_ALARM_NAME, scheduledTime: 1 },
      check,
    );
    await nextTask();

    expect(check).not.toHaveBeenCalled();
    storage.releaseFirstSet.resolve();
    await disable;
    expect(await handling).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
