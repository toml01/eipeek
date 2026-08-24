import { browser } from 'wxt/browser';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from './numbers.generated';
import {
  isDatabaseActivationChange,
  type DatabaseIndexRequest,
  type DatabaseIndexResponse,
  type DatabaseLookupResponse,
} from './database-messages';
import { DatasetRuntime, type NumberKind } from './dataset-runtime';
import type { Proposal } from './types';

/**
 * Two-tier loading. Most pages contain no EIP references at all, so the number
 * index is inlined into the content script bundle for instant rejection, while
 * the metadata payload is only requested once a page actually yields a confirmed
 * match -- and then only for the numbers on that page.
 */
const runtime = new DatasetRuntime(VALID_NUMBERS, UNMERGED_NUMBERS);

/**
 * Builds the predicate the matcher uses. Splitting the index by tier means the
 * "include open PRs" setting costs nothing at match time.
 */
export function numberValidator(includeUnmerged: boolean): (n: number) => boolean {
  return runtime.numberValidator(includeUnmerged);
}

/**
 * Why a number did or did not resolve. `hidden` is the interesting one: the
 * proposal exists but only in an open pull request, and the user has that tier
 * switched off -- worth saying so rather than claiming it does not exist.
 */
export type { NumberKind } from './dataset-runtime';

export function classify(n: number, includeUnmerged: boolean): NumberKind {
  return runtime.classify(n, includeUnmerged);
}

/**
 * Resolves metadata via the background worker, which holds the bundled JSON.
 * Routed through messaging rather than web_accessible_resources so the page has
 * no fetchable extension URL to probe for.
 */
export async function lookup(numbers: number[]): Promise<Map<number, Proposal[]>> {
  return runtime.lookup(numbers, async (request) =>
    (await browser.runtime.sendMessage(request)) as DatabaseLookupResponse | undefined,
  );
}

let refreshSequence = 0;

/** Loads the active signed precomputed index; failure leaves the bundled index intact. */
export async function refreshDatabaseIndex(): Promise<boolean> {
  const sequence = ++refreshSequence;
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'database.getIndex',
    } satisfies DatabaseIndexRequest)) as DatabaseIndexResponse | undefined;
    if (sequence !== refreshSequence || !response) return false;
    return runtime.activateIndex(response);
  } catch {
    return false;
  }
}

/**
 * storage.session is the no-tabs-permission activation signal. The listener asks
 * the worker for the small number arrays; it never exposes the large artifact to
 * the page world.
 */
export function onDatabaseActivated(fn: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (!isDatabaseActivationChange(changes, area)) return;
    void refreshDatabaseIndex().then((changed) => {
      if (changed) fn();
    });
  });
}
