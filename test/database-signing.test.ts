import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertSafeArtifactOverwrite, validatePayloadFile } from '../scripts/database-signing';

const canonicalJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const existingArtifact = readFileSync('data/database.signed.json', 'utf8');
const existingPayload = readFileSync('data/database.payload.json', 'utf8');

async function payloadBytes(mutate: (payload: any) => void): Promise<Uint8Array> {
  const payload = JSON.parse(existingPayload);
  mutate(payload);
  return validatePayloadFile(canonicalJson(payload));
}

describe('offline database signer overwrite guard', () => {
  it('rejects changed payload bytes at the existing version', async () => {
    const changed = await payloadBytes((payload) => {
      payload.proposals[0].t = `${payload.proposals[0].t} changed`;
    });
    await expect(assertSafeArtifactOverwrite(existingArtifact, changed)).rejects.toThrow(
      'different payload bytes',
    );
  });

  it('rejects a lower database version', async () => {
    const lower = await payloadBytes((payload) => {
      payload.databaseVersion -= 1;
    });
    await expect(assertSafeArtifactOverwrite(existingArtifact, lower)).rejects.toThrow('lower version');
  });

  it('permits an equal version only when payload bytes are unchanged', async () => {
    const unchanged = await validatePayloadFile(existingPayload);
    await expect(assertSafeArtifactOverwrite(existingArtifact, unchanged)).resolves.toBeUndefined();
  });
});
