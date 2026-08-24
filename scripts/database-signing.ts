import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import publicKeyDocument from '../data/database-public-key.json';
import {
  DATABASE_ARTIFACT_SCHEMA_VERSION,
  DATABASE_KEY_ID,
  DATABASE_SIGNATURE_ALGORITHM,
  validateDatabasePayload,
  verifySignedDatabase,
  type SignedDatabaseEnvelope,
  type VerifiedDatabase,
} from '../src/core/database-artifact';
import { serializeDatabasePayload } from '../src/core/database-payload';
import {
  assertGeneratedDatabaseConstants,
  reconstructCommittedDatabase,
} from './database-payload';

export function signedEnvelope(payloadBytes: Uint8Array, privateKey: KeyObject): SignedDatabaseEnvelope {
  const signature = sign('sha256', payloadBytes, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  if (signature.byteLength !== 64) throw new Error('P-256 signing did not produce a 64-byte signature');
  return {
    artifactSchemaVersion: DATABASE_ARTIFACT_SCHEMA_VERSION,
    keyId: DATABASE_KEY_ID,
    algorithm: DATABASE_SIGNATURE_ALGORITHM,
    payloadEncoding: 'base64',
    payload: Buffer.from(payloadBytes).toString('base64'),
    signature: signature.toString('base64'),
  };
}

export async function loadAndCheckPrivateKey(filename: string): Promise<KeyObject> {
  const pem = await readFile(filename);
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The signing key must be an ECDSA P-256 private key');
  }

  const derived = createPublicKey(privateKey).export({ format: 'jwk' });
  const committed = publicKeyDocument.jwk;
  for (const field of ['kty', 'crv', 'x', 'y'] as const) {
    if (derived[field] !== committed[field]) {
      throw new Error(`The private key does not match data/database-public-key.json (${field})`);
    }
  }
  return privateKey;
}

/** Validates that bytes are the one compact representation accepted at runtime. */
export function validatePayloadBytes(payloadBytes: Uint8Array): Uint8Array {
  let payloadText: string;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    throw new Error('The database payload is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    throw new Error('The database payload is not valid JSON');
  }
  const canonical = serializeDatabasePayload(validateDatabasePayload(parsed));
  if (!Buffer.from(canonical).equals(Buffer.from(payloadBytes))) {
    throw new Error('The database payload is not in compact deterministic format');
  }
  return payloadBytes;
}

/** Verifies both authenticity and exact identity with reconstructed source bytes. */
export async function verifyDatabaseBytes(
  rawArtifact: string,
  expectedPayloadBytes: Uint8Array,
  verifier: (raw: string) => Promise<VerifiedDatabase> = verifySignedDatabase,
): Promise<{
  databaseVersion: number;
  payloadSha256: string;
}> {
  const verified = await verifier(rawArtifact);
  const payloadBytes = validatePayloadBytes(expectedPayloadBytes);
  if (!Buffer.from(verified.payloadBytes).equals(Buffer.from(payloadBytes))) {
    throw new Error('data/database.signed.json does not contain the exact payload reconstructed from committed sources');
  }
  const digest = createHash('sha256').update(payloadBytes).digest('hex');
  if (verified.payloadSha256 !== digest) throw new Error('database payload digest mismatch');
  return { databaseVersion: verified.payload.databaseVersion, payloadSha256: digest };
}

export async function verifyCommittedDatabaseFiles(rawArtifact: string): Promise<{
  databaseVersion: number;
  payloadSha256: string;
}> {
  const expected = await reconstructCommittedDatabase();
  assertGeneratedDatabaseConstants(expected);
  return verifyDatabaseBytes(rawArtifact, expected.payloadBytes);
}

/**
 * Refuses to overwrite a valid committed artifact with a rollback or equivocal
 * payload. Equal-version signing is allowed only for the exact same bytes so a
 * reproducible ECDSA re-sign/no-op remains possible.
 */
export async function assertSafeArtifactOverwrite(
  rawExistingArtifact: string,
  nextPayloadBytes: Uint8Array,
): Promise<void> {
  // Permit inspection of the previously committed pretty-byte format solely so
  // the one-way migration to compact bytes can retain rollback/equivocation
  // checks. Runtime verification and the newly written artifact stay strict.
  const existing = await verifySignedDatabase(rawExistingArtifact, { requireCompactPayload: false });
  let nextValue: unknown;
  try {
    nextValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(nextPayloadBytes));
  } catch {
    throw new Error('The next database payload is not valid UTF-8 JSON');
  }
  const next = validateDatabasePayload(nextValue);
  if (next.databaseVersion < existing.payload.databaseVersion) {
    throw new Error(
      `Refusing to replace database v${existing.payload.databaseVersion} with lower version ${next.databaseVersion}`,
    );
  }
  if (next.databaseVersion !== existing.payload.databaseVersion) return;

  const nextDigest = createHash('sha256').update(nextPayloadBytes).digest('hex');
  if (
    nextDigest !== existing.payloadSha256 ||
    !Buffer.from(nextPayloadBytes).equals(Buffer.from(existing.payloadBytes))
  ) {
    throw new Error(
      `Refusing to replace database v${existing.payload.databaseVersion} with different payload bytes; increment data/database-version.json`,
    );
  }
}
