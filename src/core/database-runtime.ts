import type { DatabaseAlarmStatus } from './database-alarm';
import { DatabaseManagerError } from './database-manager';
import type {
  DatabaseActionResponse,
  DatabaseErrorResponse,
  DatabaseManagerActionResponse,
  DatabaseManagerStatus,
  DatabaseSetAutoUpdateRequest,
  DatabaseStatus,
  DatabaseStatusRequest,
  DatabaseStatusResponse,
} from './database-messages';

export interface DatabaseRuntimeManager {
  status(): Promise<DatabaseManagerStatus>;
  checkForUpdates(trigger: 'manual' | 'automatic'): Promise<DatabaseManagerActionResponse>;
  restoreBundled(): Promise<DatabaseManagerActionResponse>;
}

export interface DatabaseRuntimeScheduler {
  status(): Promise<DatabaseAlarmStatus>;
  setEnabled(enabled: boolean): Promise<DatabaseAlarmStatus>;
  reconcile(): Promise<DatabaseAlarmStatus>;
}

export type DatabaseRuntimeRequest =
  | DatabaseStatusRequest
  | { type: 'database.check' }
  | { type: 'database.restore' }
  | DatabaseSetAutoUpdateRequest;

/**
 * Combines manager and scheduler answers for extension-page database actions.
 * A successful check, restore, or toggle stays successful when a later
 * scheduler status read fails; only the mutation itself can fail the action.
 */
export class DatabaseRuntime {
  private lastKnownSchedule: DatabaseAlarmStatus | undefined;

  constructor(
    private readonly manager: DatabaseRuntimeManager,
    private readonly scheduler: DatabaseRuntimeScheduler,
  ) {}

  rememberSchedule(status: DatabaseAlarmStatus): DatabaseAlarmStatus {
    this.lastKnownSchedule = status;
    return status;
  }

  async reconcileSchedule(): Promise<DatabaseAlarmStatus> {
    return this.rememberSchedule(await this.scheduler.reconcile());
  }

  async handle(request: DatabaseRuntimeRequest): Promise<DatabaseStatusResponse | DatabaseActionResponse> {
    switch (request.type) {
      case 'database.status':
        return { ok: true, status: await this.combinedStatus() };
      case 'database.check':
        await this.ensureScheduleKnown();
        return this.finishSuccessfulMutation(await this.manager.checkForUpdates('manual'));
      case 'database.restore':
        await this.ensureScheduleKnown();
        return this.finishSuccessfulMutation(await this.manager.restoreBundled());
      case 'database.setAutoUpdate': {
        // Capture the unrelated manager status before the toggle. Once the
        // preference and alarm mutation succeed, no supplementary read can
        // convert that successful toggle into an error response.
        const managerStatus = await this.manager.status();
        const schedule = this.rememberSchedule(await this.scheduler.setEnabled(request.enabled));
        return { ok: true, status: this.mergeStatus(managerStatus, schedule) };
      }
    }
  }

  async errorResponse(error: unknown): Promise<DatabaseErrorResponse> {
    const normalized =
      error instanceof DatabaseManagerError
        ? error
        : new DatabaseManagerError('network', 'The database action failed.');
    let status: DatabaseStatus | undefined;
    try {
      status = await this.combinedStatus();
    } catch {
      // The action error remains useful even if status construction fails.
    }
    return {
      ok: false,
      code: normalized.code,
      message: normalized.message,
      ...(status ? { status } : {}),
    };
  }

  private async combinedStatus(): Promise<DatabaseStatus> {
    // Remember a successful scheduler read even if the independent manager read
    // fails and prevents construction of the combined response.
    const schedule = this.scheduler.status().then((status) => this.rememberSchedule(status));
    const [managerStatus, rememberedSchedule] = await Promise.all([this.manager.status(), schedule]);
    return this.mergeStatus(managerStatus, rememberedSchedule);
  }

  private async finishSuccessfulMutation(
    response: DatabaseManagerActionResponse,
  ): Promise<DatabaseActionResponse> {
    return {
      ...response,
      status: this.mergeStatus(response.status, await this.scheduleAfterSuccess()),
    };
  }

  private async scheduleAfterSuccess(): Promise<DatabaseAlarmStatus> {
    try {
      return this.rememberSchedule(await this.scheduler.status());
    } catch {
      // ensureScheduleKnown() runs before the manager mutation, so this fallback
      // is authoritative or last-known and never an invented enabled default.
      if (this.lastKnownSchedule) return this.lastKnownSchedule;
      throw new DatabaseManagerError('storage', 'The automatic update preference is unavailable.');
    }
  }

  private async ensureScheduleKnown(): Promise<void> {
    if (!this.lastKnownSchedule) {
      this.rememberSchedule(await this.scheduler.status());
    }
  }

  private mergeStatus(
    managerStatus: DatabaseManagerStatus,
    schedule: DatabaseAlarmStatus,
  ): DatabaseStatus {
    return { ...managerStatus, ...schedule };
  }
}
