import { getSettings, setSettings } from '../core/settings';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../core/types';
import { FEEDBACK_ISSUE_URL } from '../core/feedback';
import {
  isDatabaseActivationChange,
  type DatabaseStatus,
  type DatabaseUiResponse,
} from '../core/database-messages';
import './settings-form.css';

/**
 * The settings form, shared by the options page and the toolbar popup.
 *
 * Both surfaces are the same form, and one HTML entrypoint cannot include
 * another at build time, so the markup lives here as the single source and each
 * entrypoint is a shell that mounts it. The alternative -- pointing
 * `action.default_popup` straight at options.html -- shares even more, but then
 * the two surfaces cannot be sized differently, and a popup is capped at
 * 800x600 while the options page is not.
 */
const FORM = `
  <h1>EIPeek</h1>

  <label class="row">
    <input type="checkbox" id="enabled" />
    <span>
      <strong>Enable on pages</strong>
      <small>Highlight EIP/ERC references and show details on hover.</small>
    </span>
  </label>

  <label class="row">
    <input type="checkbox" id="bareNumbers" />
    <span>
      <strong>Also match bare numbers</strong>
      <small>
        Matches <code>7702</code> with no <code>EIP-</code> prefix. Any 1–5 digit
        proposal number counts, so years and quantities get marked too: 2025 and 3 are
        both real proposals.
      </small>
    </span>
  </label>

  <div class="sub" id="bareOptions">
    <label class="row">
      <input type="checkbox" id="predictEthBlocks" />
      <span>
        <strong>Only where the text looks Ethereum-related <span class="tag">alpha</span></strong>
        <small>
          Needs 4–5 digits, and a prefixed reference or two Ethereum terms in the same
          paragraph. Skips years and prices, and misses real references.
        </small>
      </span>
    </label>

    <div class="row">
      <span>
        <strong>Never guess on these sites</strong>
        <small>One hostname per line, subdomains included. <code>EIP-7702</code> still matches.</small>
        <textarea id="bareNumberBlockedSites" rows="3" spellcheck="false"></textarea>
      </span>
    </div>
  </div>

  <div class="row">
    <span>
      <strong>Most matches per page</strong>
      <small>0 for no limit. Beyond the limit the rest of the page is skipped.</small>
      <input type="number" id="maxMatches" min="0" step="100" />
    </span>
  </div>

  <label class="row">
    <input type="checkbox" id="includeUnmerged" />
    <span>
      <strong>Include proposals from open pull requests</strong>
      <small>
        EIP numbers are assigned while a proposal is still an open PR, and that
        is when most discussion happens — so these are often the most-referenced
        proposals. Their numbers are not final until an editor assigns them, and
        a number can have competing claims; the tooltip shows every claim and
        marks each as <em>unmerged</em>.
      </small>
    </span>
  </label>

  <label class="row">
    <input type="checkbox" id="lookupOnSelection" />
    <span>
      <strong>Look up numbers you select</strong>
      <small>
        Select <code>8141</code>, <code>EIP-8141</code> or <code>#8141</code> and its
        proposal appears, ignoring the rules above. Selecting anything other than a
        bare reference does nothing.
      </small>
    </span>
  </label>

  <label class="row">
    <input type="checkbox" id="debugMode" />
    <span>
      <strong>Debug mode</strong>
      <small>
        Say why a selected number found nothing, instead of staying silent.
      </small>
    </span>
  </label>

  <div class="row">
    <span>
      <strong>Highlight style</strong>
      <small>Only decoration and tint are available — the highlight API allows nothing else.</small>
      <select id="highlightStyle">
        <option value="underline">Dotted underline</option>
        <option value="background">Background tint</option>
        <option value="both">Both</option>
      </select>
    </span>
  </div>

  <div class="row">
    <span>
      <strong>Disabled sites</strong>
      <small>One hostname per line. Subdomains are included.</small>
      <textarea id="disabledSites" rows="4" spellcheck="false"></textarea>
    </span>
  </div>

  <p class="saved" id="saved" hidden>Saved</p>

  <section class="database" id="databaseSection" aria-labelledby="database-heading" aria-busy="true">
    <h2 id="database-heading">Database</h2>
    <dl class="database-details">
      <div>
        <dt>Active</dt>
        <dd id="databaseSource">Loading…</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd id="databaseVersion">—</dd>
      </div>
      <div>
        <dt>State</dt>
        <dd id="databaseState">Reading local database…</dd>
      </div>
      <div>
        <dt>Last check</dt>
        <dd id="databaseLastCheck">—</dd>
      </div>
    </dl>
    <small class="database-note">
      EIPeek contacts GitHub only when you choose Check for updates. Downloaded,
      signed data stays in this browser; page text and settings are never sent.
    </small>
    <div class="database-actions">
      <button type="button" id="databaseCheck" data-testid="database-check">Check for updates</button>
      <button type="button" id="databaseRestore" data-testid="database-restore">Restore bundled database</button>
    </div>
    <p
      class="database-message"
      id="databaseMessage"
      data-testid="database-message"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    ></p>
  </section>

  <section class="feedback" aria-labelledby="feedback-heading">
    <strong id="feedback-heading">Feedback</strong>
    <small>
      Found a bug, a database mistake, or have an idea? Share it on GitHub.
    </small>
    <a
      class="feedback-link"
      data-testid="feedback-link"
      href="${FEEDBACK_ISSUE_URL}"
      target="_blank"
      rel="noopener noreferrer"
    >Open a GitHub issue</a>
  </section>

  <footer>
    Data generated from
    <a href="https://github.com/ethereum/EIPs" target="_blank" rel="noopener noreferrer">ethereum/EIPs</a>
    and
    <a href="https://github.com/ethereum/ERCs" target="_blank" rel="noopener noreferrer">ethereum/ERCs</a>,
    and bundled with the extension. Browsing makes no network requests; only the
    manual database check above contacts GitHub.
  </footer>
`;

/** One hostname per line, tolerating pasted URLs. */
function parseHostList(value: string): string[] {
  return value
    .split('\n')
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    )
    .filter(Boolean);
}

/** Renders the form into `root` and wires every control to storage. */
export async function mountSettingsForm(root: HTMLElement): Promise<void> {
  root.innerHTML = FORM;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;

  const enabled = $<HTMLInputElement>('enabled');
  const bareNumbers = $<HTMLInputElement>('bareNumbers');
  const predictEthBlocks = $<HTMLInputElement>('predictEthBlocks');
  const bareNumberBlockedSites = $<HTMLTextAreaElement>('bareNumberBlockedSites');
  const maxMatches = $<HTMLInputElement>('maxMatches');
  const bareOptions = $<HTMLDivElement>('bareOptions');
  const includeUnmerged = $<HTMLInputElement>('includeUnmerged');
  const lookupOnSelection = $<HTMLInputElement>('lookupOnSelection');
  const debugMode = $<HTMLInputElement>('debugMode');
  const highlightStyle = $<HTMLSelectElement>('highlightStyle');
  const disabledSites = $<HTMLTextAreaElement>('disabledSites');
  const saved = $<HTMLParagraphElement>('saved');
  const databaseSection = $<HTMLElement>('databaseSection');
  const databaseSource = $<HTMLElement>('databaseSource');
  const databaseVersion = $<HTMLElement>('databaseVersion');
  const databaseState = $<HTMLElement>('databaseState');
  const databaseLastCheck = $<HTMLElement>('databaseLastCheck');
  const databaseCheck = $<HTMLButtonElement>('databaseCheck');
  const databaseRestore = $<HTMLButtonElement>('databaseRestore');
  const databaseMessage = $<HTMLParagraphElement>('databaseMessage');

  // Both sub-controls only mean anything while bare matching is on. Disabled
  // rather than hidden, so the option is discoverable before it applies and the
  // form does not jump as it is toggled.
  function syncBareOptions() {
    const on = bareNumbers.checked;
    predictEthBlocks.disabled = !on;
    bareNumberBlockedSites.disabled = !on;
    bareOptions.classList.toggle('off', !on);
  }

  let flashTimer: number | undefined;
  function flash() {
    saved.hidden = false;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      saved.hidden = true;
    }, 1200);
  }

  async function save(patch: Partial<Settings>) {
    await setSettings(patch);
    flash();
  }

  const settings = await getSettings();
  enabled.checked = settings.enabled;
  bareNumbers.checked = settings.bareNumbers;
  predictEthBlocks.checked = settings.predictEthBlocks;
  bareNumberBlockedSites.value = settings.bareNumberBlockedSites.join('\n');
  maxMatches.value = String(settings.maxMatches);
  includeUnmerged.checked = settings.includeUnmerged;
  lookupOnSelection.checked = settings.lookupOnSelection;
  debugMode.checked = settings.debugMode;
  highlightStyle.value = settings.highlightStyle;
  disabledSites.value = settings.disabledSites.join('\n');
  syncBareOptions();

  enabled.addEventListener('change', () => void save({ enabled: enabled.checked }));
  bareNumbers.addEventListener('change', () => {
    syncBareOptions();
    void save({ bareNumbers: bareNumbers.checked });
  });
  predictEthBlocks.addEventListener('change', () => void save({ predictEthBlocks: predictEthBlocks.checked }));
  maxMatches.addEventListener('change', () => {
    // Fall back rather than store nonsense; the field is reset so the stored
    // value and what is on screen never disagree.
    const n = Number.parseInt(maxMatches.value, 10);
    const next = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.maxMatches;
    maxMatches.value = String(next);
    void save({ maxMatches: next });
  });
  bareNumberBlockedSites.addEventListener('change', () =>
    void save({ bareNumberBlockedSites: parseHostList(bareNumberBlockedSites.value) }),
  );
  includeUnmerged.addEventListener('change', () => void save({ includeUnmerged: includeUnmerged.checked }));
  lookupOnSelection.addEventListener('change', () => void save({ lookupOnSelection: lookupOnSelection.checked }));
  debugMode.addEventListener('change', () => void save({ debugMode: debugMode.checked }));
  highlightStyle.addEventListener(
    'change',
    () => void save({ highlightStyle: highlightStyle.value as Settings['highlightStyle'] }),
  );
  disabledSites.addEventListener('change', () =>
    void save({ disabledSites: parseHostList(disabledSites.value) }),
  );

  let databaseBusy = true;
  function setDatabaseBusy(busy: boolean) {
    databaseBusy = busy;
    databaseSection.setAttribute('aria-busy', String(busy));
    databaseCheck.disabled = busy;
    // renderDatabaseStatus restores the source-dependent state after an action.
    databaseRestore.disabled = busy || databaseRestore.dataset.bundled === 'true';
  }

  function setDatabaseMessage(message: string, kind: 'busy' | 'success' | 'error' | 'none') {
    databaseMessage.textContent = message;
    databaseMessage.className = `database-message ${kind}`;
    databaseMessage.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    databaseMessage.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  }

  function renderDatabaseStatus(status: DatabaseStatus) {
    const bundled = status.source === 'bundled';
    databaseSource.textContent = bundled ? 'Bundled fallback' : 'Downloaded and signature-verified';
    databaseVersion.textContent = String(status.activeVersion);
    databaseState.textContent = bundled
      ? status.activatedAt
        ? `Restored ${formatDate(status.activatedAt)}`
        : 'Included with this extension release'
      : `Activated ${formatDate(status.activatedAt)} · ${status.proposalCount.toLocaleString()} proposals`;
    databaseLastCheck.textContent = status.lastCheckedAt
      ? `${formatDate(status.lastCheckedAt)}${status.lastCheckOutcome === 'error' ? ' · failed' : ''}`
      : 'Never';
    databaseRestore.dataset.bundled = String(bundled);
    databaseRestore.disabled = databaseBusy || bundled;
  }

  async function sendDatabaseMessage(type: 'database.status' | 'database.check' | 'database.restore') {
    return (await browser.runtime.sendMessage({ type })) as DatabaseUiResponse | undefined;
  }

  let statusRefreshSequence = 0;
  async function refreshDatabaseStatus(): Promise<void> {
    const sequence = ++statusRefreshSequence;
    const response = await sendDatabaseMessage('database.status');
    if (sequence !== statusRefreshSequence) return;
    if (!response?.ok) throw new Error(response?.message ?? 'The background worker did not respond.');
    renderDatabaseStatus(response.status);
  }

  async function databaseAction(type: 'database.check' | 'database.restore') {
    if (databaseBusy) return;
    setDatabaseBusy(true);
    setDatabaseMessage(
      type === 'database.check' ? 'Checking GitHub for a signed database…' : 'Restoring bundled database…',
      'busy',
    );
    try {
      const response = await sendDatabaseMessage(type);
      if (!response) throw new Error('The background worker did not respond.');
      if (!response.ok) {
        if (response.status) renderDatabaseStatus(response.status);
        throw new Error(response.message);
      }
      if (!('message' in response)) throw new Error('The background worker returned an unexpected response.');
      renderDatabaseStatus(response.status);
      setDatabaseMessage(response.message, 'success');
    } catch (error) {
      setDatabaseMessage(
        error instanceof Error ? error.message : 'The database action failed.',
        'error',
      );
    } finally {
      setDatabaseBusy(false);
    }
  }

  databaseCheck.addEventListener('click', () => void databaseAction('database.check'));
  databaseRestore.addEventListener('click', () => void databaseAction('database.restore'));

  // A second open popup/options page may perform the action. The session event
  // contains only a revision; fetch the trusted status from the background so
  // source/version/Restore state cannot remain stale and no artifact is exposed.
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (!isDatabaseActivationChange(changes, areaName)) return;
    void refreshDatabaseStatus().catch(() => {});
  });

  setDatabaseBusy(true);
  try {
    await refreshDatabaseStatus();
    setDatabaseMessage('', 'none');
  } catch (error) {
    databaseSource.textContent = 'Bundled fallback';
    databaseState.textContent = 'Database status is temporarily unavailable';
    databaseLastCheck.textContent = 'Unavailable';
    setDatabaseMessage(
      error instanceof Error ? error.message : 'Could not read database status.',
      'error',
    );
  } finally {
    setDatabaseBusy(false);
  }
}

function formatDate(value: string | null): string {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
