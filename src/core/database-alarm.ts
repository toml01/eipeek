export const DATABASE_DAILY_ALARM_NAME = 'eipeek.database.daily.v1';
export const DATABASE_AUTO_UPDATE_STORAGE_KEY = 'eipeek.database.autoUpdate.v1';
export const DATABASE_DAILY_PERIOD_MINUTES = 1_440;

export interface DatabaseAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export interface DatabaseAlarmApi {
  get(name: string): Promise<DatabaseAlarm | undefined>;
  create(
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number },
  ): void | Promise<void>;
  clear(name: string): Promise<boolean>;
}

export interface DatabaseAutoUpdateStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface DatabaseAlarmStatus {
  autoUpdateEnabled: boolean;
  nextScheduledCheckAt: string | null;
}

export interface DatabaseAlarmSchedulerOptions {
  alarms: DatabaseAlarmApi;
  storage: DatabaseAutoUpdateStorage;
  random?: () => number;
  now?: () => Date;
  notifyChange?: () => Promise<void>;
}

/**
 * Owns only the daily preference and alarm. Reconciliation never performs an
 * update check; the caller supplies that operation only for a matching alarm.
 */
export class DatabaseAlarmScheduler {
  private readonly alarms: DatabaseAlarmApi;
  private readonly storage: DatabaseAutoUpdateStorage;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly notifyChange: () => Promise<void>;

  constructor(options: DatabaseAlarmSchedulerOptions) {
    this.alarms = options.alarms;
    this.storage = options.storage;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.notifyChange = options.notifyChange ?? (async () => {});
  }

  async status(): Promise<DatabaseAlarmStatus> {
    const [enabled, alarm] = await Promise.all([this.isEnabled(), this.alarms.get(DATABASE_DAILY_ALARM_NAME)]);
    return {
      autoUpdateEnabled: enabled,
      nextScheduledCheckAt: enabled && isCorrectAlarm(alarm)
        ? new Date(alarm.scheduledTime).toISOString()
        : null,
    };
  }

  async setEnabled(enabled: boolean): Promise<DatabaseAlarmStatus> {
    await this.storage.set({ [DATABASE_AUTO_UPDATE_STORAGE_KEY]: enabled });
    return this.reconcile();
  }

  async reconcile(): Promise<DatabaseAlarmStatus> {
    const enabled = await this.isEnabled();
    const existing = await this.alarms.get(DATABASE_DAILY_ALARM_NAME);
    if (!enabled) {
      if (existing) await this.alarms.clear(DATABASE_DAILY_ALARM_NAME);
    } else if (!isCorrectAlarm(existing)) {
      if (existing) await this.alarms.clear(DATABASE_DAILY_ALARM_NAME);
      await this.alarms.create(DATABASE_DAILY_ALARM_NAME, {
        delayInMinutes: firstDelayMinutes(this.random()),
        periodInMinutes: DATABASE_DAILY_PERIOD_MINUTES,
      });
    }
    await this.publishChange();
    return this.status();
  }

  async handleAlarm(alarm: DatabaseAlarm, check: () => Promise<unknown>): Promise<boolean> {
    if (alarm.name !== DATABASE_DAILY_ALARM_NAME || !(await this.isEnabled())) return false;
    try {
      await check();
    } finally {
      // Chrome advances a periodic alarm's scheduledTime around delivery. Tell
      // open settings pages to ask for the authoritative next time either way;
      // reconciliation also repairs an alarm removed during delivery.
      await this.reconcile();
    }
    return true;
  }

  private async isEnabled(): Promise<boolean> {
    const stored = await this.storage.get([DATABASE_AUTO_UPDATE_STORAGE_KEY]);
    const value = stored[DATABASE_AUTO_UPDATE_STORAGE_KEY];
    return typeof value === 'boolean' ? value : true;
  }

  private async publishChange(): Promise<void> {
    try {
      await this.notifyChange();
    } catch {
      // The alarm and sync preference are authoritative. A transient session
      // signal failure must not change the schedule.
    }
  }
}

export function firstDelayMinutes(randomValue: number): number {
  const normalized = Number.isFinite(randomValue)
    ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
    : 0;
  return Math.floor(normalized * DATABASE_DAILY_PERIOD_MINUTES) + 1;
}

function isCorrectAlarm(alarm: DatabaseAlarm | undefined): alarm is DatabaseAlarm {
  return !!alarm &&
    alarm.name === DATABASE_DAILY_ALARM_NAME &&
    alarm.periodInMinutes === DATABASE_DAILY_PERIOD_MINUTES &&
    Number.isFinite(alarm.scheduledTime) &&
    alarm.scheduledTime > 0;
}
