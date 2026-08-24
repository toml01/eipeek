import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import committedPayload from '../data/database.payload.json';
import publicKeyDocument from '../data/database-public-key.json';
import proposals from '../data/eips.json';
import {
  DATABASE_ARTIFACT_SCHEMA_VERSION,
  DATABASE_KEY_ID,
  DATABASE_SCHEMA_VERSION,
  DATABASE_SIGNATURE_ALGORITHM,
  DatabaseArtifactError,
  MAX_DATABASE_ARTIFACT_BYTES,
  validateDatabasePayload,
  verifySignedDatabase,
  type DatabasePayload,
  type SignedDatabaseEnvelope,
} from '../src/core/database-artifact';
import {
  BUNDLED_DATABASE_PAYLOAD_SHA256,
  BUNDLED_DATABASE_VERSION,
} from '../src/core/database.generated';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from '../src/core/numbers.generated';
import type { Proposal } from '../src/core/types';

const canonicalJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const payload = committedPayload as DatabasePayload;

const testKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testPublicKey = testKeys.publicKey.export({ format: 'jwk' });
const TEST_KEY_ID = 'test-database-key';

function signedArtifact(value: unknown): string {
  const payloadBytes = Buffer.from(canonicalJson(value));
  const signature = sign('sha256', payloadBytes, {
    key: testKeys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const envelope: SignedDatabaseEnvelope = {
    artifactSchemaVersion: DATABASE_ARTIFACT_SCHEMA_VERSION,
    keyId: TEST_KEY_ID,
    algorithm: DATABASE_SIGNATURE_ALGORITHM,
    payloadEncoding: 'base64',
    payload: payloadBytes.toString('base64'),
    signature: signature.toString('base64'),
  };
  return canonicalJson(envelope);
}

function testPayload(): DatabasePayload {
  const value = structuredClone(payload);
  value.keyId = TEST_KEY_ID;
  return value;
}

describe('committed signed database', () => {
  it('has canonical reviewable inputs and a valid P-256 signature', async () => {
    const rawPayload = readFileSync('data/database.payload.json', 'utf8');
    const rawArtifact = readFileSync('data/database.signed.json', 'utf8');
    const rawPublicKey = readFileSync('data/database-public-key.json', 'utf8');
    const rawVersion = readFileSync('data/database-version.json', 'utf8');

    expect(rawPayload).toBe(canonicalJson(JSON.parse(rawPayload)));
    expect(rawArtifact).toBe(canonicalJson(JSON.parse(rawArtifact)));
    expect(rawPublicKey).toBe(canonicalJson(JSON.parse(rawPublicKey)));
    expect(rawVersion).toBe(canonicalJson(JSON.parse(rawVersion)));

    const verified = await verifySignedDatabase(rawArtifact);
    expect(Buffer.from(verified.payloadBytes).toString()).toBe(rawPayload);
    expect(verified.payload.databaseVersion).toBe(BUNDLED_DATABASE_VERSION);
    expect(verified.payload.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    expect(verified.payload.keyId).toBe(DATABASE_KEY_ID);
    expect(verified.payloadSha256).toBe(BUNDLED_DATABASE_PAYLOAD_SHA256);
    expect(createHash('sha256').update(rawPayload).digest('hex')).toBe(
      BUNDLED_DATABASE_PAYLOAD_SHA256,
    );
  });

  it('bundles only an ECDSA P-256 verification key', () => {
    expect(publicKeyDocument).toMatchObject({
      schemaVersion: 1,
      keyId: DATABASE_KEY_ID,
      algorithm: 'ECDSA_P256_SHA256',
      jwk: { kty: 'EC', crv: 'P-256', key_ops: ['verify'], ext: true },
    });
    expect(Object.keys(publicKeyDocument.jwk).sort()).toEqual(
      ['crv', 'ext', 'key_ops', 'kty', 'x', 'y'].sort(),
    );
    expect(JSON.stringify(publicKeyDocument)).not.toMatch(/\b(?:d|privateKey)\b/);
  });

  it('builds the payload from the committed proposals and precomputed number arrays', () => {
    const runtimeProposals = (proposals as Proposal[]).map((proposal) => ({
      ...proposal,
      disc: proposal.disc.startsWith('https://') ? proposal.disc : '',
    }));
    expect(payload.proposals).toEqual(runtimeProposals);
    expect(payload.mergedNumbers).toEqual(VALID_NUMBERS);
    expect(payload.unmergedNumbers).toEqual(UNMERGED_NUMBERS);
  });

  it('verifies exact signed bytes before attempting payload schema validation', async () => {
    const envelope = JSON.parse(readFileSync('data/database.signed.json', 'utf8'));
    envelope.payload = Buffer.from('{"schemaVersion":0}').toString('base64');
    await expect(verifySignedDatabase(canonicalJson(envelope))).rejects.toMatchObject({
      code: 'invalid-signature',
    });
  });

  it('rejects oversized input before JSON parsing', async () => {
    await expect(verifySignedDatabase('x'.repeat(MAX_DATABASE_ARTIFACT_BYTES + 1))).rejects.toMatchObject({
      code: 'artifact-too-large',
    });
  });

  it('classifies malformed framing as an envelope error', async () => {
    await expect(verifySignedDatabase('[]')).rejects.toMatchObject({ code: 'invalid-envelope' });
  });
});

describe('signed payload validation', () => {
  it('accepts a separately generated P-256 Web Crypto test vector', async () => {
    const value = testPayload();
    const verified = await verifySignedDatabase(signedArtifact(value), {
      publicKey: testPublicKey,
      expectedKeyId: TEST_KEY_ID,
    });
    expect(verified.payload.databaseVersion).toBe(value.databaseVersion);
  });

  it('rejects a correctly signed payload with an invalid schema', async () => {
    const value = testPayload() as DatabasePayload & { unexpected?: boolean };
    value.unexpected = true;
    await expect(
      verifySignedDatabase(signedArtifact(value), {
        publicKey: testPublicKey,
        expectedKeyId: TEST_KEY_ID,
      }),
    ).rejects.toMatchObject({ code: 'invalid-schema' });
  });

  it.each([
    ['unknown top-level key', (value: any) => (value.extra = true)],
    ['invalid version date', (value: any) => (value.databaseVersion = 2026130101)],
    ['unsupported status', (value: any) => (value.proposals[0].s = 'Accepted')],
    ['non-HTTPS discussion URL', (value: any) => (value.proposals[0].disc = 'http://example.com')],
    ['unknown proposal key', (value: any) => (value.proposals[0].author = 'remote code')],
    [
      'incomplete open-PR provenance',
      (value: any) => {
        const open = value.proposals.find((proposal: any) => proposal.pr !== undefined);
        delete open.prRef;
      },
    ],
    [
      'out-of-bounds integer',
      (value: any) => {
        value.proposals[0].req = [100000];
      },
    ],
    [
      'unsorted number index',
      (value: any) => {
        [value.mergedNumbers[0], value.mergedNumbers[1]] = [
          value.mergedNumbers[1],
          value.mergedNumbers[0],
        ];
      },
    ],
    [
      'duplicate number index entry',
      (value: any) => {
        value.mergedNumbers[1] = value.mergedNumbers[0];
      },
    ],
    [
      'tier/index disagreement',
      (value: any) => {
        value.mergedNumbers.pop();
      },
    ],
    [
      'proposal count below the release floor',
      (value: any) => {
        value.proposals = value.proposals.slice(0, 10);
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const value = testPayload();
    mutate(value);
    try {
      validateDatabasePayload(value, TEST_KEY_ID);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseArtifactError);
      expect((error as DatabaseArtifactError).code).toBe('invalid-schema');
    }
  });
});
