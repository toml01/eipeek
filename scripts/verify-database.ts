/** Verifies the committed signed artifact without any private key material. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyDatabaseFiles } from './database-signing';

const ROOT = path.resolve(import.meta.dirname, '..');
const rawArtifact = await readFile(path.join(ROOT, 'data', 'database.signed.json'), 'utf8');
const rawPayload = await readFile(path.join(ROOT, 'data', 'database.payload.json'), 'utf8');
const verified = await verifyDatabaseFiles(rawArtifact, rawPayload);

process.stdout.write(
  `Verified database v${verified.databaseVersion} (${verified.payloadSha256}) with the bundled public key\n`,
);
