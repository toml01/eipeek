import type { Proposal } from './types';

/** Small revision-only signal exposed to content scripts through storage.session. */
export const DATABASE_ACTIVATION_STORAGE_KEY = 'eipeek.database.activation.v1';
/** Small refresh-only signal for open popup/options surfaces. */
export const DATABASE_UI_CHANGE_STORAGE_KEY = 'eipeek.database.uiChange.v1';

export interface DatabaseActivationSignal {
  revision: number;
}

export type DatabaseSource = 'bundled' | 'downloaded';
export type DatabaseCheckOutcome = 'activated' | 'current' | 'error';

export interface DatabaseStatus {
  source: DatabaseSource;
  activeVersion: number;
  bundledVersion: number;
  highWaterVersion: number;
  revision: number;
  proposalCount: number;
  mergedNumberCount: number;
  unmergedNumberCount: number;
  activatedAt: string | null;
  downloadedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckOutcome: DatabaseCheckOutcome | null;
  lastCheckMessage: string | null;
  busy: boolean;
  autoUpdateEnabled: boolean;
  nextScheduledCheckAt: string | null;
}

export type DatabaseManagerStatus = Omit<
  DatabaseStatus,
  'autoUpdateEnabled' | 'nextScheduledCheckAt'
>;

export interface DatabaseIndexResponse {
  revision: number;
  databaseVersion: number;
  mergedNumbers: number[];
  unmergedNumbers: number[];
}

export interface DatabaseLookupResponse {
  revision: number;
  proposals: Record<number, Proposal[]>;
}

export interface DatabaseStatusRequest {
  type: 'database.status';
}

export interface DatabaseCheckRequest {
  type: 'database.check';
}

export interface DatabaseRestoreRequest {
  type: 'database.restore';
}

export interface DatabaseSetAutoUpdateRequest {
  type: 'database.setAutoUpdate';
  enabled: boolean;
}

export interface DatabaseIndexRequest {
  type: 'database.getIndex';
}

export interface LookupRequest {
  type: 'lookup';
  numbers: number[];
  revision: number;
}

export type RuntimeRequest =
  | DatabaseStatusRequest
  | DatabaseCheckRequest
  | DatabaseRestoreRequest
  | DatabaseSetAutoUpdateRequest
  | DatabaseIndexRequest
  | LookupRequest;

export interface DatabaseActionResponse {
  ok: true;
  outcome: 'activated' | 'current' | 'restored';
  message: string;
  status: DatabaseStatus;
}

export interface DatabaseManagerActionResponse extends Omit<DatabaseActionResponse, 'status'> {
  status: DatabaseManagerStatus;
}

export interface DatabaseStatusResponse {
  ok: true;
  status: DatabaseStatus;
}

export interface DatabaseErrorResponse {
  ok: false;
  code: string;
  message: string;
  status?: DatabaseStatus;
}

export type DatabaseUiResponse = DatabaseActionResponse | DatabaseStatusResponse | DatabaseErrorResponse;

/**
 * Narrows the global storage event to the one small cross-context signal. Local
 * database slots and state are deliberately not part of this protocol.
 */
export function isDatabaseActivationChange(
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
): boolean {
  if (areaName !== 'session') return false;
  const change = changes[DATABASE_ACTIVATION_STORAGE_KEY];
  if (!change || change.newValue === null || typeof change.newValue !== 'object') return false;
  const signal = change.newValue as Record<string, unknown>;
  return (
    Object.keys(signal).length === 1 &&
    Number.isSafeInteger(signal.revision) &&
    (signal.revision as number) >= 0
  );
}

export function isDatabaseUiChange(
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
): boolean {
  if (isDatabaseActivationChange(changes, areaName)) return true;
  if (areaName !== 'session') return false;
  const change = changes[DATABASE_UI_CHANGE_STORAGE_KEY];
  if (!change || change.newValue === null || typeof change.newValue !== 'object') return false;
  const signal = change.newValue as Record<string, unknown>;
  return Object.keys(signal).length === 1 &&
    Number.isSafeInteger(signal.revision) &&
    (signal.revision as number) >= 0;
}

/** Rejects extra fields, including any attempt to supply a URL. */
export function parseRuntimeRequest(value: unknown): RuntimeRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== 'string') return null;
  if (
    message.type === 'database.status' ||
    message.type === 'database.check' ||
    message.type === 'database.restore' ||
    message.type === 'database.getIndex'
  ) {
    return Object.keys(message).length === 1 ? (message as unknown as RuntimeRequest) : null;
  }
  if (message.type === 'database.setAutoUpdate') {
    return Object.keys(message).sort().join(',') === 'enabled,type' && typeof message.enabled === 'boolean'
      ? (message as unknown as DatabaseSetAutoUpdateRequest)
      : null;
  }
  if (message.type !== 'lookup' || Object.keys(message).sort().join(',') !== 'numbers,revision,type') {
    return null;
  }
  if (!Number.isSafeInteger(message.revision) || (message.revision as number) < 0) return null;
  if (!Array.isArray(message.numbers) || message.numbers.length > 2_000) return null;
  if (
    message.numbers.some(
      (number) => !Number.isInteger(number) || (number as number) <= 0 || (number as number) > 99_999,
    )
  ) {
    return null;
  }
  return message as unknown as LookupRequest;
}

export function isDatabaseMutationRequest(
  request: RuntimeRequest,
): request is DatabaseCheckRequest | DatabaseRestoreRequest | DatabaseSetAutoUpdateRequest {
  return request.type === 'database.check' ||
    request.type === 'database.restore' ||
    request.type === 'database.setAutoUpdate';
}

/** Database mutations are privileged to popup/options pages, never content scripts. */
export function isExtensionPageSender(
  sender: { url?: string; tab?: unknown },
  extensionRoot: string,
): boolean {
  // Options can legitimately be opened in a normal tab, in which case Chrome
  // includes sender.tab. The unforgeable extension URL is the boundary; content
  // scripts retain the page's http(s) URL even though their sender.id is ours.
  return typeof sender.url === 'string' && sender.url.startsWith(extensionRoot);
}
