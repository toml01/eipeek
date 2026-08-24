import type { DatabaseIndexResponse, DatabaseLookupResponse, LookupRequest } from './database-messages';
import type { Proposal } from './types';

export type NumberKind = 'merged' | 'unmerged' | 'hidden' | 'unknown';
export type LookupSender = (request: LookupRequest) => Promise<DatabaseLookupResponse | undefined>;

/**
 * Per-content-script database state. Activation swaps the signed number arrays
 * as one unit and invalidates both hits and remembered misses. An epoch rejects
 * lookups that began against an older database, even if their reply arrives
 * after the storage activation signal.
 */
export class DatasetRuntime {
  private merged: Set<number>;
  private unmerged: Set<number>;
  private revisionValue = 0;
  private databaseVersionValue = 0;
  private epoch = 0;
  private readonly cache = new Map<number, Proposal[]>();

  constructor(mergedNumbers: readonly number[], unmergedNumbers: readonly number[]) {
    this.merged = new Set(mergedNumbers);
    this.unmerged = new Set(unmergedNumbers);
  }

  get revision(): number {
    return this.revisionValue;
  }

  get databaseVersion(): number {
    return this.databaseVersionValue;
  }

  numberValidator(includeUnmerged: boolean): (number: number) => boolean {
    const merged = this.merged;
    const unmerged = this.unmerged;
    if (!includeUnmerged) return (number) => merged.has(number);
    return (number) => merged.has(number) || unmerged.has(number);
  }

  classify(number: number, includeUnmerged: boolean): NumberKind {
    if (this.merged.has(number)) return 'merged';
    if (this.unmerged.has(number)) return includeUnmerged ? 'unmerged' : 'hidden';
    return 'unknown';
  }

  /** Uses the arrays received from the background exactly; it derives nothing from metadata. */
  activateIndex(index: DatabaseIndexResponse): boolean {
    if (!validIndexResponse(index)) return false;
    const changed =
      index.revision !== this.revisionValue ||
      index.databaseVersion !== this.databaseVersionValue ||
      !sameSet(this.merged, index.mergedNumbers) ||
      !sameSet(this.unmerged, index.unmergedNumbers);
    if (!changed) return false;

    this.merged = new Set(index.mergedNumbers);
    this.unmerged = new Set(index.unmergedNumbers);
    this.revisionValue = index.revision;
    this.databaseVersionValue = index.databaseVersion;
    this.epoch++;
    this.cache.clear();
    return true;
  }

  async lookup(numbers: number[], send: LookupSender): Promise<Map<number, Proposal[]>> {
    const missing = [...new Set(numbers.filter((number) => !this.cache.has(number)))];
    if (missing.length > 0) {
      const epoch = this.epoch;
      const revision = this.revisionValue;
      try {
        const response = await send({ type: 'lookup', numbers: missing, revision });
        if (
          epoch === this.epoch &&
          response?.revision === revision &&
          response.proposals !== null &&
          typeof response.proposals === 'object' &&
          !Array.isArray(response.proposals)
        ) {
          for (const number of missing) {
            const entries = response.proposals[number];
            this.cache.set(number, Array.isArray(entries) ? entries : []);
          }
        }
      } catch {
        // Worker asleep or extension reloading; leave misses uncached so hover retries.
      }
    }

    const output = new Map<number, Proposal[]>();
    for (const number of numbers) {
      const entries = this.cache.get(number);
      if (entries?.length) output.set(number, entries);
    }
    return output;
  }
}

function validIndexResponse(value: DatabaseIndexResponse): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.databaseVersion) ||
    value.databaseVersion <= 0 ||
    !sortedUniqueNumbers(value.mergedNumbers) ||
    !sortedUniqueNumbers(value.unmergedNumbers)
  ) return false;
  const merged = new Set(value.mergedNumbers);
  return value.unmergedNumbers.every((number) => !merged.has(number));
}

function sortedUniqueNumbers(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  return value.every(
    (number, index) =>
      Number.isInteger(number) &&
      number > 0 &&
      number <= 99_999 &&
      (index === 0 || number > value[index - 1]),
  );
}

function sameSet(current: Set<number>, next: number[]): boolean {
  return current.size === next.length && next.every((number) => current.has(number));
}
