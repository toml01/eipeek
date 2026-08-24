import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DATABASE_KEY_ID,
  DATABASE_SCHEMA_VERSION,
  validDatabaseVersion,
  type DatabasePayload,
} from '../src/core/database-artifact';
import {
  constructDatabasePayload,
  serializeDatabasePayload,
} from '../src/core/database-payload';
import {
  BUNDLED_DATABASE_PAYLOAD_SHA256,
  BUNDLED_DATABASE_VERSION,
} from '../src/core/database.generated';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../src/core/numbers.generated';
import type { Proposal } from '../src/core/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROPOSALS_FILE = path.join(ROOT, 'data', 'eips.json');
const DATABASE_VERSION_FILE = path.join(ROOT, 'data', 'database-version.json');

export interface DatabaseVersionDocument {
  schemaVersion: typeof DATABASE_SCHEMA_VERSION;
  databaseVersion: number;
  keyId: string;
}

export interface ConstructedDatabase {
  payload: DatabasePayload;
  payloadBytes: Uint8Array;
  payloadSha256: string;
}

export async function readDatabaseVersion(): Promise<DatabaseVersionDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(DATABASE_VERSION_FILE, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read data/database-version.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('data/database-version.json must be an object');
  }
  const document = parsed as Record<string, unknown>;
  const keys = Object.keys(document).sort();
  const expected = ['databaseVersion', 'keyId', 'schemaVersion'];
  if (keys.join('\0') !== expected.join('\0')) {
    throw new Error('data/database-version.json must contain exactly schemaVersion, databaseVersion and keyId');
  }
  if (document.schemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`data/database-version.json schemaVersion must be ${DATABASE_SCHEMA_VERSION}`);
  }
  if (!validDatabaseVersion(document.databaseVersion)) {
    throw new Error('data/database-version.json databaseVersion must be a valid YYYYMMDDNN integer');
  }
  if (document.keyId !== DATABASE_KEY_ID) {
    throw new Error('data/database-version.json keyId must match data/database-public-key.json');
  }
  return document as unknown as DatabaseVersionDocument;
}

export async function constructDatabaseFromSources(
  proposals: readonly Proposal[],
  mergedNumbers: readonly number[],
  unmergedNumbers: readonly number[],
): Promise<ConstructedDatabase> {
  const version = await readDatabaseVersion();
  const payload = constructDatabasePayload({
    databaseVersion: version.databaseVersion,
    keyId: version.keyId,
    proposals,
    mergedNumbers,
    unmergedNumbers,
  });
  const payloadBytes = serializeDatabasePayload(payload);
  return {
    payload,
    payloadBytes,
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
  };
}

/** Reconstructs the exact signed bytes without any standalone payload file. */
export async function reconstructCommittedDatabase(): Promise<ConstructedDatabase> {
  const parsed = JSON.parse(await readFile(PROPOSALS_FILE, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('data/eips.json must contain a proposal array');
  return constructDatabaseFromSources(
    parsed as Proposal[],
    VALID_NUMBERS,
    UNMERGED_NUMBERS,
  );
}

/** Prevents signing or accepting source bytes while bundled constants are stale. */
export function assertGeneratedDatabaseConstants(database: ConstructedDatabase): void {
  if (database.payload.databaseVersion !== BUNDLED_DATABASE_VERSION) {
    throw new Error('src/core/database.generated.ts has a stale database version; run npm run data:build -- --database-only');
  }
  if (database.payloadSha256 !== BUNDLED_DATABASE_PAYLOAD_SHA256) {
    throw new Error('src/core/database.generated.ts has a stale payload digest; run npm run data:build -- --database-only');
  }
}
