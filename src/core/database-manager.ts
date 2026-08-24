import {
  DatabaseArtifactError,
  MAX_DATABASE_ARTIFACT_BYTES,
  verifySignedDatabase,
  type DatabasePayload,
  type VerifiedDatabase,
} from './database-artifact';
import {
  type DatabaseActivationSignal,
  type DatabaseCheckOutcome,
  type DatabaseIndexResponse,
  type DatabaseLookupResponse,
  type DatabaseSource,
  type DatabaseManagerActionResponse,
  type DatabaseManagerStatus,
} from './database-messages';
import type { Proposal } from './types';

/** The only runtime update locations. They are compile-time fixed and accept no input. */
export const DATABASE_UPDATE_URL =
  'https://api.github.com/repos/toml01/eipeek/contents/data/database.signed.json?ref=main';
export const DATABASE_VERSION_HINT_URL =
  'https://api.github.com/repos/toml01/eipeek/contents/data/database-version.json?ref=main';
export const DATABASE_UPDATE_ACCEPT = 'application/vnd.github.raw+json';
export const DATABASE_UPDATE_TIMEOUT_MS = 15_000;
export const MAX_DATABASE_VERSION_HINT_BYTES = 4 * 1_024;

const DATABASE_STATUS_STORAGE_KEY = 'eipeek.database.status.v1';
/** Trusted-context-only persistent pointer; never use this as a content-script signal. */
export const DATABASE_STATE_STORAGE_KEY = 'eipeek.database.state.v1';
const DATABASE_SLOT_KEYS = [
  'eipeek.database.slot.0.v1',
  'eipeek.database.slot.1.v1',
] as const;
const STORAGE_SCHEMA_VERSION = 1 as const;

export interface DatabaseStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface StoredDatabaseState {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  activeSource: DatabaseSource;
  activeSlot: 0 | 1 | null;
  lastDownloadedSlot: 0 | 1 | null;
  activeVersion: number;
  activeDigest: string;
  highWaterVersion: number;
  highWaterDigest: string;
  activatedAt: string | null;
  revision: number;
}

interface StoredDatabaseSlot {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  envelope: string;
  databaseVersion: number;
  payloadDigest: string;
  downloadedAt: string;
}

interface StoredDatabaseStatus {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  lastCheckedAt: string | null;
  outcome: DatabaseCheckOutcome | null;
  message: string | null;
}

interface ActiveDatabase {
  source: DatabaseSource;
  payload: DatabasePayload;
  payloadDigest: string;
  activatedAt: string | null;
  downloadedAt: string | null;
  revision: number;
}

export interface DatabaseManagerOptions {
  storage: DatabaseStorage;
  bundledPayload: DatabasePayload;
  bundledPayloadDigest: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  verify?: (raw: string) => Promise<VerifiedDatabase>;
  now?: () => Date;
  timeoutMs?: number;
  notifyActivation?: (signal: DatabaseActivationSignal) => Promise<void>;
  notifyStatusChange?: () => Promise<void>;
}

export type DatabaseManagerErrorCode =
  | 'busy'
  | 'network'
  | 'timeout'
  | 'http'
  | 'artifact-too-large'
  | 'hint-too-large'
  | 'invalid-hint'
  | 'hint-mismatch'
  | 'invalid-envelope'
  | 'invalid-signature'
  | 'invalid-schema'
  | 'rollback'
  | 'version-conflict'
  | 'storage';

export class DatabaseManagerError extends Error {
  constructor(
    public readonly code: DatabaseManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseManagerError';
  }
}

/**
 * Owns the active database, signature verification and two-slot atomic storage.
 * A download is written only to the inactive slot, read back and reverified,
 * then activated by one small state-pointer write. Any failure leaves the old
 * pointer and in-memory database untouched.
 */
export class DatabaseManager {
  private readonly storage: DatabaseStorage;
  private readonly bundledPayload: DatabasePayload;
  private readonly bundledPayloadDigest: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  private readonly verify: (raw: string) => Promise<VerifiedDatabase>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly notifyActivation: (signal: DatabaseActivationSignal) => Promise<void>;
  private readonly notifyStatusChange: () => Promise<void>;
  private ready: Promise<void> | null = null;
  private busy = false;
  private metadataIndex: Map<number, Proposal[]> | null = null;
  private state: StoredDatabaseState;
  private checkStatus: StoredDatabaseStatus = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    lastCheckedAt: null,
    outcome: null,
    message: null,
  };
  private active: ActiveDatabase;

  constructor(options: DatabaseManagerOptions) {
    this.storage = options.storage;
    this.bundledPayload = options.bundledPayload;
    this.bundledPayloadDigest = options.bundledPayloadDigest;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.verify = options.verify ?? ((raw) => verifySignedDatabase(raw));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DATABASE_UPDATE_TIMEOUT_MS;
    this.notifyActivation = options.notifyActivation ?? (async () => {});
    this.notifyStatusChange = options.notifyStatusChange ?? (async () => {});
    this.state = this.defaultState();
    this.active = this.bundledActive(this.state.revision, null);
  }

  /** Revalidates persisted bytes. This method never performs a network request. */
  initialize(): Promise<void> {
    if (!this.ready) this.ready = this.initializeOnce();
    return this.ready;
  }

  async status(): Promise<DatabaseManagerStatus> {
    await this.initialize();
    return this.currentStatus();
  }

  async getNumberIndex(): Promise<DatabaseIndexResponse> {
    await this.initialize();
    return {
      revision: this.active.revision,
      databaseVersion: this.active.payload.databaseVersion,
      // Return the signed arrays themselves. They are not reconstructed from proposals.
      mergedNumbers: [...this.active.payload.mergedNumbers],
      unmergedNumbers: [...this.active.payload.unmergedNumbers],
    };
  }

  async lookup(numbers: number[], _requestedRevision: number): Promise<DatabaseLookupResponse> {
    await this.initialize();
    const snapshot = this.active;
    const index = this.getMetadataIndex();
    const proposals: Record<number, Proposal[]> = {};
    for (const number of numbers) {
      const entries = index.get(number);
      if (entries?.length) proposals[number] = entries;
    }
    return { revision: snapshot.revision, proposals };
  }

  async checkForUpdates(trigger: 'manual' | 'automatic' = 'manual'): Promise<DatabaseManagerActionResponse> {
    await this.initialize();
    if (this.busy) throw new DatabaseManagerError('busy', 'Another database action is already running.');
    this.busy = true;
    let outcome: DatabaseManagerActionResponse['outcome'];
    let message: string;
    try {
      let hintVersion: number | null = null;
      if (trigger === 'automatic') {
        hintVersion = await this.downloadVersionHint();
        if (hintVersion <= this.state.highWaterVersion) {
          outcome = 'current';
          message = `Automatic check found no version newer than ${this.state.highWaterVersion}.`;
          await this.recordCheck('current', message);
          return { ok: true, outcome, message, status: this.currentStatus(false) };
        }
      }

      const rawArtifact = await this.downloadArtifact();
      const verified = await this.verify(rawArtifact);
      this.enforceMonotonicVersion(verified);
      if (hintVersion !== null && verified.payload.databaseVersion !== hintVersion) {
        throw new DatabaseManagerError(
          'hint-mismatch',
          `Rejected database ${verified.payload.databaseVersion}: the version hint announced ${hintVersion}.`,
        );
      }

      if (
        this.active.source === 'downloaded' &&
        verified.payload.databaseVersion === this.active.payload.databaseVersion &&
        verified.payloadSha256 === this.active.payloadDigest
      ) {
        outcome = 'current';
        message = `Database ${verified.payload.databaseVersion} is already active.`;
        await this.recordCheck('current', message);
      } else {
        await this.stageAndActivate(rawArtifact, verified);
        outcome = 'activated';
        message = `Verified and activated database ${verified.payload.databaseVersion}.`;
      }
    } catch (error) {
      const normalized = normalizeError(error);
      await this.recordCheck('error', normalized.message);
      throw normalized;
    } finally {
      this.busy = false;
      await this.publishStatusChange();
    }
    return { ok: true, outcome, message, status: this.currentStatus() };
  }

  async restoreBundled(): Promise<DatabaseManagerActionResponse> {
    await this.initialize();
    if (this.busy) throw new DatabaseManagerError('busy', 'Another database action is already running.');
    this.busy = true;
    try {
      if (this.active.source === 'bundled') {
        return {
          ok: true,
          outcome: 'current',
          message: `Bundled database ${this.bundledPayload.databaseVersion} is already active.`,
          status: this.currentStatus(false),
        };
      }

      const activatedAt = this.nowIso();
      const nextState: StoredDatabaseState = {
        ...this.state,
        activeSource: 'bundled',
        activeSlot: null,
        activeVersion: this.bundledPayload.databaseVersion,
        activeDigest: this.bundledPayloadDigest,
        activatedAt,
        revision: nextRevision(this.state.revision),
      };
      try {
        await this.storage.set({ [DATABASE_STATE_STORAGE_KEY]: nextState });
      } catch {
        throw new DatabaseManagerError('storage', 'Could not save the bundled database selection.');
      }
      this.state = nextState;
      this.activate(this.bundledActive(nextState.revision, activatedAt));
      await this.publishActivation(nextState.revision);
      return {
        ok: true,
        outcome: 'restored',
        message: `Restored bundled database ${this.bundledPayload.databaseVersion}.`,
        status: this.currentStatus(false),
      };
    } finally {
      this.busy = false;
      await this.publishStatusChange();
    }
  }

  private async initializeOnce(): Promise<void> {
    let stored: Record<string, unknown>;
    try {
      stored = await this.storage.get([
        DATABASE_STATE_STORAGE_KEY,
        DATABASE_STATUS_STORAGE_KEY,
        ...DATABASE_SLOT_KEYS,
      ]);
    } catch {
      return; // Bundled fallback remains active when local storage is unavailable.
    }

    const status = parseStoredStatus(stored[DATABASE_STATUS_STORAGE_KEY]);
    if (status) this.checkStatus = status;
    const state = parseStoredState(stored[DATABASE_STATE_STORAGE_KEY]);
    if (!state) return;

    // A newer extension package raises the floor even after the user previously
    // restored an older bundled version. The trusted package wins this migration.
    if (
      state.highWaterVersion < this.bundledPayload.databaseVersion ||
      (state.highWaterVersion === this.bundledPayload.databaseVersion &&
        state.highWaterDigest !== this.bundledPayloadDigest)
    ) {
      await this.recoverToBundled(state, this.bundledPayload.databaseVersion, this.bundledPayloadDigest);
      return;
    }

    if (state.activeSource === 'bundled') {
      if (
        state.activeSlot !== null ||
        state.activeVersion !== this.bundledPayload.databaseVersion ||
        state.activeDigest !== this.bundledPayloadDigest
      ) {
        await this.recoverToBundled(state, state.highWaterVersion, state.highWaterDigest);
        return;
      }
      this.state = state;
      this.activate(this.bundledActive(state.revision, state.activatedAt));
      // Reverify the retained downloaded copy after restart too, but never make
      // an uncommitted/staged slot active merely because it happens to be valid.
      if (state.lastDownloadedSlot !== null) {
        await this.readVerifiedSlot(stored[DATABASE_SLOT_KEYS[state.lastDownloadedSlot]]);
      }
      return;
    }

    if (
      state.activeSlot === null ||
      state.lastDownloadedSlot !== state.activeSlot ||
      state.activeVersion !== state.highWaterVersion ||
      state.activeDigest !== state.highWaterDigest
    ) {
      await this.recoverToBundled(state, state.highWaterVersion, state.highWaterDigest);
      return;
    }
    const slot = await this.readVerifiedSlot(stored[DATABASE_SLOT_KEYS[state.activeSlot]]);
    if (
      !slot ||
      slot.verified.payload.databaseVersion !== state.activeVersion ||
      slot.verified.payloadSha256 !== state.activeDigest
    ) {
      await this.recoverToBundled(state, state.highWaterVersion, state.highWaterDigest);
      return;
    }
    this.state = state;
    this.activate({
      source: 'downloaded',
      payload: slot.verified.payload,
      payloadDigest: slot.verified.payloadSha256,
      activatedAt: state.activatedAt,
      downloadedAt: slot.record.downloadedAt,
      revision: state.revision,
    });
  }

  private async recoverToBundled(
    previous: StoredDatabaseState,
    highWaterVersion: number,
    highWaterDigest: string,
  ): Promise<void> {
    const recovered: StoredDatabaseState = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      activeSource: 'bundled',
      activeSlot: null,
      lastDownloadedSlot: previous.lastDownloadedSlot,
      activeVersion: this.bundledPayload.databaseVersion,
      activeDigest: this.bundledPayloadDigest,
      highWaterVersion,
      highWaterDigest,
      activatedAt: this.nowIso(),
      revision: nextRevision(previous.revision),
    };
    try {
      await this.storage.set({ [DATABASE_STATE_STORAGE_KEY]: recovered });
    } catch {
      // Recovery still succeeds in memory. Storage is never cleared, so a later
      // run can re-evaluate the prior slot instead of destroying evidence/data.
    }
    this.state = recovered;
    this.activate(this.bundledActive(recovered.revision, recovered.activatedAt));
    await this.publishActivation(recovered.revision);
  }

  private async stageAndActivate(rawArtifact: string, verified: VerifiedDatabase): Promise<void> {
    const slotNumber: 0 | 1 = this.state.lastDownloadedSlot === 0 ? 1 : 0;
    const slotKey = DATABASE_SLOT_KEYS[slotNumber];
    const timestamp = this.nowIso();
    const slot: StoredDatabaseSlot = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      envelope: rawArtifact,
      databaseVersion: verified.payload.databaseVersion,
      payloadDigest: verified.payloadSha256,
      downloadedAt: timestamp,
    };

    try {
      await this.storage.set({ [slotKey]: slot });
      const readBack = await this.storage.get([slotKey]);
      const staged = await this.readVerifiedSlot(readBack[slotKey]);
      if (
        !staged ||
        staged.verified.payload.databaseVersion !== verified.payload.databaseVersion ||
        staged.verified.payloadSha256 !== verified.payloadSha256
      ) {
        throw new Error('staged database changed during storage round-trip');
      }

      const nextState: StoredDatabaseState = {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        activeSource: 'downloaded',
        activeSlot: slotNumber,
        lastDownloadedSlot: slotNumber,
        activeVersion: verified.payload.databaseVersion,
        activeDigest: verified.payloadSha256,
        highWaterVersion: verified.payload.databaseVersion,
        highWaterDigest: verified.payloadSha256,
        activatedAt: timestamp,
        revision: nextRevision(this.state.revision),
      };
      const nextStatus: StoredDatabaseStatus = {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        lastCheckedAt: timestamp,
        outcome: 'activated',
        message: `Verified and activated database ${verified.payload.databaseVersion}.`,
      };
      // This pointer/high-water write is the atomic activation boundary. The old
      // active slot remains untouched until this succeeds.
      await this.storage.set({
        [DATABASE_STATE_STORAGE_KEY]: nextState,
        [DATABASE_STATUS_STORAGE_KEY]: nextStatus,
      });
      this.state = nextState;
      this.checkStatus = nextStatus;
      this.activate({
        source: 'downloaded',
        payload: staged.verified.payload,
        payloadDigest: staged.verified.payloadSha256,
        activatedAt: timestamp,
        downloadedAt: staged.record.downloadedAt,
        revision: nextState.revision,
      });
      await this.publishActivation(nextState.revision);
    } catch (error) {
      if (error instanceof DatabaseManagerError) throw error;
      throw new DatabaseManagerError('storage', 'Could not stage and atomically activate the database.');
    }
  }

  private async readVerifiedSlot(
    value: unknown,
  ): Promise<{ record: StoredDatabaseSlot; verified: VerifiedDatabase } | null> {
    const record = parseStoredSlot(value);
    if (!record) return null;
    try {
      const verified = await this.verify(record.envelope);
      if (
        verified.payload.databaseVersion !== record.databaseVersion ||
        verified.payloadSha256 !== record.payloadDigest
      ) {
        return null;
      }
      return { record, verified };
    } catch {
      return null;
    }
  }

  private enforceMonotonicVersion(verified: VerifiedDatabase): void {
    const version = verified.payload.databaseVersion;
    if (version < this.state.highWaterVersion) {
      throw new DatabaseManagerError(
        'rollback',
        `Rejected database ${version}: version ${this.state.highWaterVersion} was previously accepted.`,
      );
    }
    if (version === this.state.highWaterVersion && verified.payloadSha256 !== this.state.highWaterDigest) {
      throw new DatabaseManagerError(
        'version-conflict',
        `Rejected database ${version}: that version was previously accepted with different content.`,
      );
    }
  }

  private async downloadArtifact(): Promise<string> {
    return this.downloadFixedFile(
      DATABASE_UPDATE_URL,
      MAX_DATABASE_ARTIFACT_BYTES,
      'artifact-too-large',
      'The downloaded database file is too large.',
      'database',
    );
  }

  private async downloadVersionHint(): Promise<number> {
    const raw = await this.downloadFixedFile(
      DATABASE_VERSION_HINT_URL,
      MAX_DATABASE_VERSION_HINT_BYTES,
      'hint-too-large',
      'The GitHub database version hint is too large.',
      'version hint',
    );
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new DatabaseManagerError('invalid-hint', 'GitHub returned an invalid database version hint.');
    }
    if (!exactObject(value, ['schemaVersion', 'databaseVersion', 'keyId'])) {
      throw new DatabaseManagerError('invalid-hint', 'GitHub returned an invalid database version hint.');
    }
    const hint = value as Record<string, unknown>;
    if (
      hint.schemaVersion !== 1 ||
      !positiveSafeInteger(hint.databaseVersion) ||
      hint.keyId !== this.bundledPayload.keyId
    ) {
      throw new DatabaseManagerError('invalid-hint', 'GitHub returned an invalid database version hint.');
    }
    return hint.databaseVersion;
  }

  private async downloadFixedFile(
    url: string,
    maximumBytes: number,
    tooLargeCode: 'artifact-too-large' | 'hint-too-large',
    tooLargeMessage: string,
    requestName: string,
  ): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: { Accept: DATABASE_UPDATE_ACCEPT },
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DatabaseManagerError('http', `GitHub returned HTTP ${response.status}.`);
      }
      return await readLimitedUtf8(response, maximumBytes, tooLargeCode, tooLargeMessage);
    } catch (error) {
      if (error instanceof DatabaseManagerError) throw error;
      if (timedOut) throw new DatabaseManagerError('timeout', `The GitHub ${requestName} request timed out.`);
      throw new DatabaseManagerError('network', `Could not download the database ${requestName} from GitHub.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordCheck(outcome: DatabaseCheckOutcome, message: string): Promise<void> {
    const status: StoredDatabaseStatus = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      lastCheckedAt: this.nowIso(),
      outcome,
      message: message.slice(0, 300),
    };
    this.checkStatus = status;
    try {
      await this.storage.set({ [DATABASE_STATUS_STORAGE_KEY]: status });
    } catch {
      // Check failures must never replace the useful original error merely
      // because recording its timestamp also failed.
    }
  }

  private getMetadataIndex(): Map<number, Proposal[]> {
    if (this.metadataIndex) return this.metadataIndex;
    const index = new Map<number, Proposal[]>();
    for (const proposal of this.active.payload.proposals) {
      for (const number of [proposal.n, ...(proposal.aka ?? [])]) {
        const entries = index.get(number);
        if (entries) entries.push(proposal);
        else index.set(number, [proposal]);
      }
    }
    this.metadataIndex = index;
    return index;
  }

  private activate(database: ActiveDatabase): void {
    this.active = database;
    this.metadataIndex = null;
  }

  private async publishActivation(revision: number): Promise<void> {
    try {
      await this.notifyActivation({ revision });
    } catch {
      // The trusted local pointer remains the atomic activation boundary. A
      // transient session-storage failure must not report that committed data
      // was rejected; new/reloaded content scripts still request the active index.
    }
  }

  private async publishStatusChange(): Promise<void> {
    try {
      await this.notifyStatusChange();
    } catch {
      // Status remains durable in local storage. This signal is only an
      // opportunistic refresh for concurrently open extension pages.
    }
  }

  private bundledActive(revision: number, activatedAt: string | null): ActiveDatabase {
    return {
      source: 'bundled',
      payload: this.bundledPayload,
      payloadDigest: this.bundledPayloadDigest,
      activatedAt,
      downloadedAt: null,
      revision,
    };
  }

  private defaultState(): StoredDatabaseState {
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      activeSource: 'bundled',
      activeSlot: null,
      lastDownloadedSlot: null,
      activeVersion: this.bundledPayload.databaseVersion,
      activeDigest: this.bundledPayloadDigest,
      highWaterVersion: this.bundledPayload.databaseVersion,
      highWaterDigest: this.bundledPayloadDigest,
      activatedAt: null,
      revision: 0,
    };
  }

  private currentStatus(forceBusy = this.busy): DatabaseManagerStatus {
    return {
      source: this.active.source,
      activeVersion: this.active.payload.databaseVersion,
      bundledVersion: this.bundledPayload.databaseVersion,
      highWaterVersion: this.state.highWaterVersion,
      revision: this.active.revision,
      proposalCount: this.active.payload.proposals.length,
      mergedNumberCount: this.active.payload.mergedNumbers.length,
      unmergedNumberCount: this.active.payload.unmergedNumbers.length,
      activatedAt: this.active.activatedAt,
      downloadedAt: this.active.downloadedAt,
      lastCheckedAt: this.checkStatus.lastCheckedAt,
      lastCheckOutcome: this.checkStatus.outcome,
      lastCheckMessage: this.checkStatus.message,
      busy: forceBusy,
    };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

async function readLimitedUtf8(
  response: Response,
  maximumBytes: number,
  tooLargeCode: 'artifact-too-large' | 'hint-too-large' = 'artifact-too-large',
  tooLargeMessage = 'The downloaded database file is too large.',
): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maximumBytes) {
    throw new DatabaseManagerError(tooLargeCode, tooLargeMessage);
  }
  if (!response.body) throw new DatabaseManagerError('network', 'GitHub returned an empty database response.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new DatabaseManagerError(tooLargeCode, tooLargeMessage);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DatabaseManagerError('invalid-envelope', 'The downloaded database file is not valid UTF-8.');
  }
}

function parseStoredState(value: unknown): StoredDatabaseState | null {
  if (!exactObject(value, [
    'schemaVersion',
    'activeSource',
    'activeSlot',
    'lastDownloadedSlot',
    'activeVersion',
    'activeDigest',
    'highWaterVersion',
    'highWaterDigest',
    'activatedAt',
    'revision',
  ])) return null;
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    (state.activeSource !== 'bundled' && state.activeSource !== 'downloaded') ||
    !slotOrNull(state.activeSlot) ||
    !slotOrNull(state.lastDownloadedSlot) ||
    !positiveSafeInteger(state.activeVersion) ||
    !digest(state.activeDigest) ||
    !positiveSafeInteger(state.highWaterVersion) ||
    !digest(state.highWaterDigest) ||
    !isoOrNull(state.activatedAt) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0
  ) return null;
  return state as unknown as StoredDatabaseState;
}

function parseStoredSlot(value: unknown): StoredDatabaseSlot | null {
  if (!exactObject(value, ['schemaVersion', 'envelope', 'databaseVersion', 'payloadDigest', 'downloadedAt'])) {
    return null;
  }
  const slot = value as Record<string, unknown>;
  if (
    slot.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    typeof slot.envelope !== 'string' ||
    new TextEncoder().encode(slot.envelope).byteLength > MAX_DATABASE_ARTIFACT_BYTES ||
    !positiveSafeInteger(slot.databaseVersion) ||
    !digest(slot.payloadDigest) ||
    !isoOrNull(slot.downloadedAt) ||
    slot.downloadedAt === null
  ) return null;
  return slot as unknown as StoredDatabaseSlot;
}

function parseStoredStatus(value: unknown): StoredDatabaseStatus | null {
  if (!exactObject(value, ['schemaVersion', 'lastCheckedAt', 'outcome', 'message'])) return null;
  const status = value as Record<string, unknown>;
  if (
    status.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !isoOrNull(status.lastCheckedAt) ||
    ![null, 'activated', 'current', 'error'].includes(status.outcome as never) ||
    !(status.message === null || (typeof status.message === 'string' && status.message.length <= 300))
  ) return null;
  return status as unknown as StoredDatabaseStatus;
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function slotOrNull(value: unknown): value is 0 | 1 | null {
  return value === null || value === 0 || value === 1;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isoOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.endsWith('Z'));
}

function nextRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}

function normalizeError(error: unknown): DatabaseManagerError {
  if (error instanceof DatabaseManagerError) return error;
  if (error instanceof DatabaseArtifactError) {
    return new DatabaseManagerError(error.code, error.message);
  }
  return new DatabaseManagerError('network', 'The database update failed.');
}
