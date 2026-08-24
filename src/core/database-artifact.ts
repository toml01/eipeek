import publicKeyDocument from '../../data/database-public-key.json';
import type { Proposal } from './types';

export const DATABASE_SCHEMA_VERSION = 1 as const;
export const DATABASE_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const DATABASE_SIGNATURE_ALGORITHM = 'ECDSA_P256_SHA256' as const;
export const DATABASE_KEY_ID = publicKeyDocument.keyId;

/** Hard limits are checked before allocating or walking remote-controlled data. */
export const MAX_DATABASE_ARTIFACT_BYTES = 1_500_000;
export const MAX_DATABASE_PAYLOAD_BYTES = 1_100_000;
export const MAX_DATABASE_PROPOSALS = 5_000;
export const MAX_DATABASE_NUMBERS = 10_000;
const MIN_DATABASE_PROPOSALS = 1_000;
const MIN_MERGED_NUMBERS = 900;
const MAX_PROPOSAL_NUMBER = 99_999;

const PROPOSAL_STATUSES = new Set([
  'Draft',
  'Review',
  'Last Call',
  'Final',
  'Stagnant',
  'Withdrawn',
  'Living',
]);
const PROPOSAL_TYPES = new Set([
  'Standards Track',
  'Meta',
  'Informational',
  'Irregular State Transition',
]);
const PROPOSAL_CATEGORIES = new Set(['', 'Core', 'Networking', 'Interface', 'ERC']);

export interface DatabasePayload {
  schemaVersion: typeof DATABASE_SCHEMA_VERSION;
  databaseVersion: number;
  keyId: string;
  proposals: Proposal[];
  mergedNumbers: number[];
  unmergedNumbers: number[];
}

export interface SignedDatabaseEnvelope {
  artifactSchemaVersion: typeof DATABASE_ARTIFACT_SCHEMA_VERSION;
  keyId: string;
  algorithm: typeof DATABASE_SIGNATURE_ALGORITHM;
  payloadEncoding: 'base64';
  payload: string;
  signature: string;
}

export interface VerifiedDatabase {
  payload: DatabasePayload;
  payloadBytes: Uint8Array;
  payloadSha256: string;
}

export type DatabaseArtifactErrorCode =
  | 'artifact-too-large'
  | 'invalid-envelope'
  | 'invalid-signature'
  | 'invalid-schema';

export class DatabaseArtifactError extends Error {
  constructor(
    public readonly code: DatabaseArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseArtifactError';
  }
}

export interface VerifyDatabaseOptions {
  /** Test/signing tooling may supply a key; production callers always omit it. */
  publicKey?: JsonWebKey;
  expectedKeyId?: string;
  subtle?: SubtleCrypto;
  /** Offline migration tooling may inspect an older, valid non-compact artifact. */
  requireCompactPayload?: boolean;
}

/**
 * Verifies the exact decoded payload bytes before parsing or validating them.
 * The envelope's fixed fields are the minimum framing needed to locate those
 * bytes and the signature; no remotely supplied key or URL is ever consulted.
 */
export async function verifySignedDatabase(
  rawArtifact: string,
  options: VerifyDatabaseOptions = {},
): Promise<VerifiedDatabase> {
  if (byteLength(rawArtifact) > MAX_DATABASE_ARTIFACT_BYTES) {
    throw new DatabaseArtifactError('artifact-too-large', 'The downloaded database file is too large.');
  }

  const expectedKeyId = options.expectedKeyId ?? DATABASE_KEY_ID;
  const envelope = parseEnvelope(rawArtifact, expectedKeyId);
  const payloadBytes = decodeBase64(envelope.payload, 'payload', MAX_DATABASE_PAYLOAD_BYTES);
  const signature = decodeBase64(envelope.signature, 'signature', 64);
  if (signature.byteLength !== 64) {
    throw new DatabaseArtifactError('invalid-envelope', 'The database signature has the wrong length.');
  }

  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DatabaseArtifactError('invalid-signature', 'Signature verification is unavailable.');
  }

  let valid = false;
  try {
    const key = await subtle.importKey(
      'jwk',
      options.publicKey ?? (publicKeyDocument.jwk as JsonWebKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      cryptoBuffer(signature),
      cryptoBuffer(payloadBytes),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new DatabaseArtifactError('invalid-signature', 'The database signature is invalid.');
  }

  let payloadText: string;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    throw new DatabaseArtifactError('invalid-schema', 'The signed database payload is not valid UTF-8.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    throw new DatabaseArtifactError('invalid-schema', 'The signed database payload is not valid JSON.');
  }

  const payload = validateDatabasePayload(parsed, expectedKeyId);
  // One logical database has one signed representation. This makes signatures,
  // generated digests and source reconstruction compare byte-for-byte rather
  // than accepting alternate whitespace or object-key orderings.
  if (options.requireCompactPayload !== false && payloadText !== JSON.stringify(payload)) {
    throw new DatabaseArtifactError(
      'invalid-schema',
      'The signed database payload is not in the required compact deterministic format.',
    );
  }
  const payloadSha256 = await sha256Hex(payloadBytes, subtle);
  return { payload, payloadBytes, payloadSha256 };
}

/** Strict validation for the signed, fixed-schema data payload. */
export function validateDatabasePayload(value: unknown, expectedKeyId = DATABASE_KEY_ID): DatabasePayload {
  const payload = objectAt(value, 'payload');
  exactKeys(
    payload,
    ['schemaVersion', 'databaseVersion', 'keyId', 'proposals', 'mergedNumbers', 'unmergedNumbers'],
    [],
    'payload',
  );
  if (payload.schemaVersion !== DATABASE_SCHEMA_VERSION) {
    schemaError('payload.schemaVersion must be 1');
  }
  if (!validDatabaseVersion(payload.databaseVersion)) {
    schemaError('payload.databaseVersion must be a valid YYYYMMDDNN integer');
  }
  if (payload.keyId !== expectedKeyId) schemaError('payload.keyId is not the trusted signing key');
  if (!Array.isArray(payload.proposals)) schemaError('payload.proposals must be an array');
  if (
    payload.proposals.length < MIN_DATABASE_PROPOSALS ||
    payload.proposals.length > MAX_DATABASE_PROPOSALS
  ) {
    schemaError(`payload.proposals count must be between ${MIN_DATABASE_PROPOSALS} and ${MAX_DATABASE_PROPOSALS}`);
  }

  const proposals = payload.proposals.map((proposal, index) =>
    validateProposal(proposal, `payload.proposals[${index}]`),
  );
  assertProposalOrdering(proposals);

  const mergedNumbers = validateNumberIndex(
    payload.mergedNumbers,
    'payload.mergedNumbers',
    MIN_MERGED_NUMBERS,
  );
  const unmergedNumbers = validateNumberIndex(payload.unmergedNumbers, 'payload.unmergedNumbers', 1);
  const mergedSet = new Set(mergedNumbers);
  for (const number of unmergedNumbers) {
    if (mergedSet.has(number)) schemaError(`number ${number} appears in both number indexes`);
  }

  assertTierAndIndexConsistency(proposals, mergedNumbers, unmergedNumbers);
  return {
    schemaVersion: DATABASE_SCHEMA_VERSION,
    databaseVersion: payload.databaseVersion as number,
    keyId: expectedKeyId,
    proposals,
    mergedNumbers,
    unmergedNumbers,
  };
}

export function validDatabaseVersion(value: unknown): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 2_000_010_100 || (value as number) > 9_999_123_199) {
    return false;
  }
  const text = String(value);
  if (!/^\d{10}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export async function sha256Hex(
  value: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', cryptoBuffer(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseEnvelope(raw: string, expectedKeyId: string): SignedDatabaseEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DatabaseArtifactError('invalid-envelope', 'The downloaded database is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DatabaseArtifactError('invalid-envelope', 'The database envelope is invalid.');
  }
  const envelope = parsed as Record<string, unknown>;
  exactKeys(
    envelope,
    ['artifactSchemaVersion', 'keyId', 'algorithm', 'payloadEncoding', 'payload', 'signature'],
    [],
    'artifact',
    'invalid-envelope',
  );
  if (envelope.artifactSchemaVersion !== DATABASE_ARTIFACT_SCHEMA_VERSION) {
    throw new DatabaseArtifactError('invalid-envelope', 'The database envelope version is unsupported.');
  }
  if (envelope.keyId !== expectedKeyId) {
    throw new DatabaseArtifactError('invalid-envelope', 'The database was not made for the trusted signing key.');
  }
  if (envelope.algorithm !== DATABASE_SIGNATURE_ALGORITHM) {
    throw new DatabaseArtifactError('invalid-envelope', 'The database signature algorithm is unsupported.');
  }
  if (envelope.payloadEncoding !== 'base64') {
    throw new DatabaseArtifactError('invalid-envelope', 'The database payload encoding is unsupported.');
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new DatabaseArtifactError('invalid-envelope', 'The database envelope is missing signed bytes.');
  }
  return envelope as unknown as SignedDatabaseEnvelope;
}

function validateProposal(value: unknown, at: string): Proposal {
  const proposal = objectAt(value, at);
  exactKeys(
    proposal,
    ['n', 't', 'd', 's', 'ty', 'c', 'k', 'disc', 'cr', 'req'],
    ['u', 'pr', 'prRepo', 'prRef', 'prHead', 'prOpened', 'prFileN', 'aka'],
    at,
  );

  positiveInteger(proposal.n, `${at}.n`);
  boundedString(proposal.t, `${at}.t`, 1, 300, true);
  boundedString(proposal.d, `${at}.d`, 0, 2_000, true);
  allowedString(proposal.s, PROPOSAL_STATUSES, `${at}.s`);
  allowedString(proposal.ty, PROPOSAL_TYPES, `${at}.ty`);
  allowedString(proposal.c, PROPOSAL_CATEGORIES, `${at}.c`);
  allowedString(proposal.k, new Set(['eip', 'erc']), `${at}.k`);
  boundedString(proposal.disc, `${at}.disc`, 0, 2_048, true);
  if (proposal.disc !== '' && !isHttpsUrl(proposal.disc)) {
    schemaError(`${at}.disc must be empty or an HTTPS URL`);
  }
  boundedString(proposal.cr, `${at}.cr`, 10, 10, true);
  if (!validDateOnly(proposal.cr as string)) schemaError(`${at}.cr must be a real YYYY-MM-DD date`);

  const req = validateIntegerArray(proposal.req, `${at}.req`, 0, 100);
  let upgrades: Proposal['u'];
  if (proposal.u !== undefined) {
    if (!Array.isArray(proposal.u) || proposal.u.length === 0 || proposal.u.length > 50) {
      schemaError(`${at}.u must be a non-empty array with at most 50 entries`);
    }
    let reachedScheduled = false;
    const seen = new Set<string>();
    upgrades = proposal.u.map((value, index) => {
      const upgradeAt = `${at}.u[${index}]`;
      const upgrade = objectAt(value, upgradeAt);
      exactKeys(upgrade, ['n', 's', 'm'], [], upgradeAt);
      boundedString(upgrade.n, `${upgradeAt}.n`, 1, 100, true);
      allowedString(upgrade.s, new Set(['included', 'scheduled']), `${upgradeAt}.s`);
      positiveInteger(upgrade.m, `${upgradeAt}.m`);
      if (seen.has(upgrade.n as string)) schemaError(`${at}.u contains duplicate upgrade names`);
      seen.add(upgrade.n as string);
      if (upgrade.s === 'scheduled') reachedScheduled = true;
      else if (reachedScheduled) schemaError(`${at}.u must list included upgrades before scheduled upgrades`);
      return { n: upgrade.n as string, s: upgrade.s as 'included' | 'scheduled', m: upgrade.m as number };
    });
  }

  const openFields = ['pr', 'prRepo', 'prRef', 'prHead', 'prOpened', 'prFileN'] as const;
  const hasOpenField = openFields.some((key) => proposal[key] !== undefined);
  if (hasOpenField) {
    positiveInteger(proposal.pr, `${at}.pr`, 10_000_000);
    allowedString(proposal.prRepo, new Set(['EIPs', 'ERCs']), `${at}.prRepo`);
    boundedString(proposal.prRef, `${at}.prRef`, 40, 40, true);
    if (!/^[0-9a-f]{40}$/.test(proposal.prRef as string)) schemaError(`${at}.prRef must be a full commit hash`);
    boundedString(proposal.prHead, `${at}.prHead`, 3, 200, true);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(proposal.prHead as string)) {
      schemaError(`${at}.prHead must be a GitHub owner/repository pair`);
    }
    boundedString(proposal.prOpened, `${at}.prOpened`, 20, 30, true);
    if (!validIsoInstant(proposal.prOpened as string)) schemaError(`${at}.prOpened must be an ISO UTC instant`);
    if (proposal.prFileN !== undefined) positiveInteger(proposal.prFileN, `${at}.prFileN`);
  }

  let aka: number[] | undefined;
  if (proposal.aka !== undefined) {
    aka = validateIntegerArray(proposal.aka, `${at}.aka`, 1, 20);
    if (aka.includes(proposal.n as number)) schemaError(`${at}.aka must not repeat the canonical number`);
  }

  return {
    n: proposal.n as number,
    t: proposal.t as string,
    d: proposal.d as string,
    s: proposal.s as string,
    ty: proposal.ty as string,
    c: proposal.c as string,
    k: proposal.k as 'eip' | 'erc',
    disc: proposal.disc as string,
    cr: proposal.cr as string,
    req,
    ...(upgrades ? { u: upgrades } : {}),
    ...(proposal.pr !== undefined ? { pr: proposal.pr as number } : {}),
    ...(proposal.prRepo !== undefined ? { prRepo: proposal.prRepo as 'EIPs' | 'ERCs' } : {}),
    ...(proposal.prRef !== undefined ? { prRef: proposal.prRef as string } : {}),
    ...(proposal.prHead !== undefined ? { prHead: proposal.prHead as string } : {}),
    ...(proposal.prOpened !== undefined ? { prOpened: proposal.prOpened as string } : {}),
    ...(proposal.prFileN !== undefined ? { prFileN: proposal.prFileN as number } : {}),
    ...(aka ? { aka } : {}),
  };
}

function assertProposalOrdering(proposals: Proposal[]): void {
  const mergedCanonical = new Set<number>();
  for (let index = 0; index < proposals.length; index++) {
    const proposal = proposals[index]!;
    if (proposal.pr === undefined) {
      if (mergedCanonical.has(proposal.n)) schemaError(`merged proposal number ${proposal.n} is duplicated`);
      mergedCanonical.add(proposal.n);
    }
    if (index === 0) continue;
    const previous = proposals[index - 1]!;
    const order =
      previous.n - proposal.n ||
      Number(previous.pr !== undefined) - Number(proposal.pr !== undefined) ||
      (previous.prOpened ?? '').localeCompare(proposal.prOpened ?? '');
    if (order > 0) schemaError('payload.proposals is not in canonical number/tier/PR order');
  }
}

function assertTierAndIndexConsistency(
  proposals: Proposal[],
  mergedNumbers: number[],
  unmergedNumbers: number[],
): void {
  const merged = new Set<number>();
  const unmerged = new Set<number>();
  for (const proposal of proposals) {
    const target = proposal.pr === undefined ? merged : unmerged;
    target.add(proposal.n);
    for (const alias of proposal.aka ?? []) target.add(alias);
  }
  for (const number of merged) unmerged.delete(number);
  const expectedMerged = [...merged].sort((a, b) => a - b);
  const expectedUnmerged = [...unmerged].sort((a, b) => a - b);
  if (!sameNumbers(mergedNumbers, expectedMerged)) {
    schemaError('payload.mergedNumbers does not exactly index the merged proposal tier');
  }
  if (!sameNumbers(unmergedNumbers, expectedUnmerged)) {
    schemaError('payload.unmergedNumbers does not exactly index the open-PR proposal tier');
  }
}

function validateNumberIndex(value: unknown, at: string, minimum: number): number[] {
  return validateIntegerArray(value, at, minimum, MAX_DATABASE_NUMBERS);
}

function validateIntegerArray(value: unknown, at: string, minimum: number, maximum: number): number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    schemaError(`${at} must contain between ${minimum} and ${maximum} integers`);
  }
  const numbers = value as unknown[];
  let previous = 0;
  for (let index = 0; index < numbers.length; index++) {
    positiveInteger(numbers[index], `${at}[${index}]`);
    const number = numbers[index] as number;
    if (index > 0 && number <= previous) schemaError(`${at} must be sorted and unique`);
    previous = number;
  }
  return numbers as number[];
}

function positiveInteger(value: unknown, at: string, maximum = MAX_PROPOSAL_NUMBER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    schemaError(`${at} must be an integer between 1 and ${maximum}`);
  }
}

function boundedString(
  value: unknown,
  at: string,
  minimum: number,
  maximum: number,
  trimmed: boolean,
): asserts value is string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    schemaError(`${at} must be a string between ${minimum} and ${maximum} characters`);
  }
  if (trimmed && value !== value.trim()) schemaError(`${at} must not have surrounding whitespace`);
  if (/\p{Cc}/u.test(value)) schemaError(`${at} must not contain control characters`);
}

function allowedString(value: unknown, allowed: Set<string>, at: string): asserts value is string {
  if (typeof value !== 'string' || !allowed.has(value)) schemaError(`${at} has an unsupported value`);
}

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    schemaError(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  at: string,
  code: DatabaseArtifactErrorCode = 'invalid-schema',
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    throw new DatabaseArtifactError(
      code,
      `${at} has unexpected keys${missing.length ? `; missing ${missing.join(', ')}` : ''}${
        extra.length ? `; extra ${extra.join(', ')}` : ''
      }`,
    );
  }
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/Z$/, '.000Z');
}

function decodeBase64(value: string, label: string, maximumBytes: number): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new DatabaseArtifactError('invalid-envelope', `The database ${label} is not canonical base64.`);
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new DatabaseArtifactError('invalid-envelope', `The database ${label} is not valid base64.`);
  }
  if (decoded.length > maximumBytes) {
    throw new DatabaseArtifactError('artifact-too-large', `The database ${label} is too large.`);
  }
  if (btoa(decoded) !== value) {
    throw new DatabaseArtifactError('invalid-envelope', `The database ${label} is not canonical base64.`);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** DOM Web Crypto excludes SharedArrayBuffer; make that guarantee explicit to TS. */
function cryptoBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer as ArrayBuffer;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function schemaError(message: string): never {
  throw new DatabaseArtifactError('invalid-schema', message);
}
