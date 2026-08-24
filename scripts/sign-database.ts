/**
 * Offline/manual signer for the payload emitted by `npm run data:build`.
 *
 * Usage: npm run data:sign -- .secrets/database-signing-private.pem
 */
import { execFileSync } from 'node:child_process';
import { stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeArtifactOverwrite,
  loadAndCheckPrivateKey,
  signedEnvelope,
  validatePayloadFile,
  verifyDatabaseFiles,
} from './database-signing';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAYLOAD = path.join(ROOT, 'data', 'database.payload.json');
const ARTIFACT = path.join(ROOT, 'data', 'database.signed.json');

const argument = process.argv[2];
if (!argument || process.argv.length !== 3) {
  throw new Error('Usage: npm run data:sign -- <ignored-P-256-private-key.pem>');
}
const keyPath = path.resolve(process.cwd(), argument);
const relativeKey = path.relative(ROOT, keyPath);
if (relativeKey && !relativeKey.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeKey)) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', relativeKey], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    throw new Error('Refusing to use a private key inside the repository unless Git ignores it');
  }
}
const mode = (await stat(keyPath)).mode & 0o777;
if ((mode & 0o077) !== 0) throw new Error('The private key must not be readable by group or other users');

const rawPayload = await readFile(PAYLOAD, 'utf8');
const payloadBytes = await validatePayloadFile(rawPayload);
try {
  const existingArtifact = await readFile(ARTIFACT, 'utf8');
  await assertSafeArtifactOverwrite(existingArtifact, payloadBytes);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const privateKey = await loadAndCheckPrivateKey(keyPath);
const artifact = `${JSON.stringify(signedEnvelope(payloadBytes, privateKey), null, 2)}\n`;
await writeFile(ARTIFACT, artifact, { mode: 0o644 });

const verified = await verifyDatabaseFiles(artifact, rawPayload);
process.stdout.write(
  `Signed database v${verified.databaseVersion} (${verified.payloadSha256}) with ${relativeKey || keyPath}\n`,
);
