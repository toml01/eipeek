import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertSafeArtifactOverwrite,
  validatePayloadBytes,
  verifyDatabaseBytes,
} from '../scripts/database-signing';
import { reconstructCommittedDatabase } from '../scripts/database-payload';
import { serializeDatabasePayload } from '../src/core/database-payload';
import { validateDatabasePayload } from '../src/core/database-artifact';

const existingArtifact = readFileSync('data/database.signed.json', 'utf8');
const existingPayload = await reconstructCommittedDatabase();

function payloadBytes(mutate: (payload: any) => void): Uint8Array {
  const payload = structuredClone(existingPayload.payload);
  mutate(payload);
  return serializeDatabasePayload(validateDatabasePayload(payload));
}

describe('offline database signer overwrite guard', () => {
  it('rejects changed payload bytes at the existing version', async () => {
    const changed = payloadBytes((payload) => {
      payload.proposals[0].t = `${payload.proposals[0].t} changed`;
    });
    await expect(assertSafeArtifactOverwrite(existingArtifact, changed)).rejects.toThrow(
      'different payload bytes',
    );
  });

  it('rejects a lower database version', async () => {
    const lower = payloadBytes((payload) => {
      payload.databaseVersion -= 1;
    });
    await expect(assertSafeArtifactOverwrite(existingArtifact, lower)).rejects.toThrow('lower version');
  });

  it('permits an equal version only when payload bytes are unchanged', async () => {
    const unchanged = validatePayloadBytes(existingPayload.payloadBytes);
    await expect(assertSafeArtifactOverwrite(existingArtifact, unchanged)).resolves.toBeUndefined();
  });

  it('rejects a valid signed artifact that is unrelated to reconstructed source bytes', async () => {
    const unrelatedExpected = payloadBytes((payload) => {
      payload.databaseVersion += 1;
    });
    await expect(verifyDatabaseBytes(existingArtifact, unrelatedExpected)).rejects.toThrow(
      'exact payload reconstructed from committed sources',
    );
  });
});
