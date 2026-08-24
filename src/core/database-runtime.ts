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

  async handle(request: DatabaseRuntimeRequest): Promise<DatabaseStatusResponse | DatabaseActionResponse> {
    switch (request.type) {
      case 'database.status':
        return { ok: true, status: await this.combinedStatus() };
      case 'database.check':
        return this.finishSuccessfulMutation(await this.manager.checkForUpdates('manual'));
      case 'database.restore':
        return this.finishSuccessfulMutation(await this.manager.restoreBundled());
      case 'database.setAutoUpdate': {
        const schedule = this.rememberSchedule(await this.scheduler.setEnabled(request.enabled));
        return { ok: true, status: this.mergeStatus(await this.manager.status(), schedule) };
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
    const [managerStatus, schedule] = await Promise.all([this.manager.status(), this.scheduler.status()]);
    return this.mergeStatus(managerStatus, this.rememberSchedule(schedule));
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
      // The mutation already succeeded. Reuse the last observed schedule rather
      // than turning that success into a generic failure. The unread scheduler
      // default is only used when no schedule has been observed yet.
      return this.lastKnownSchedule ?? { autoUpdateEnabled: true, nextScheduledCheckAt: null };
    }
  }

  private mergeStatus(
    managerStatus: DatabaseManagerStatus,
    schedule: DatabaseAlarmStatus,
  ): DatabaseStatus {
    return { ...managerStatus, ...schedule };
  }
}
