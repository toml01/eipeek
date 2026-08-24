import {
  DATABASE_KEY_ID,
  DATABASE_SCHEMA_VERSION,
  validateDatabasePayload,
  type DatabasePayload,
} from './database-artifact';
import type { Proposal } from './types';

export interface DatabasePayloadSources {
  databaseVersion: number;
  proposals: readonly Proposal[];
  mergedNumbers: readonly number[];
  unmergedNumbers: readonly number[];
  /** Signing tests may supply another key; production callers always omit it. */
  keyId?: string;
}

/**
 * Constructs the one runtime payload from committed, reviewable sources.
 * data/aliases.json is deliberately not an input: only its reviewed, derived
 * `aka` fields and number-index entries in generated data reach this function.
 */
export function constructDatabasePayload(sources: DatabasePayloadSources): DatabasePayload {
  // Some open PRs use placeholders such as "TBD" in discussions-to. Preserve
  // those in the review dataset, but runtime data carries only strict HTTPS URLs.
  const runtimeProposals = sources.proposals.map((proposal) => ({
    ...proposal,
    disc: httpsUrlOrEmpty(proposal.disc),
  }));

  return validateDatabasePayload(
    {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      databaseVersion: sources.databaseVersion,
      keyId: sources.keyId ?? DATABASE_KEY_ID,
      proposals: runtimeProposals,
      mergedNumbers: [...sources.mergedNumbers],
      unmergedNumbers: [...sources.unmergedNumbers],
    },
    sources.keyId ?? DATABASE_KEY_ID,
  );
}

/** Exact deterministic bytes carried by and signed inside the envelope. */
export function serializeDatabasePayload(payload: DatabasePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function httpsUrlOrEmpty(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
      ? value
      : '';
  } catch {
    return '';
  }
}
