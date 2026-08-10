import { getSettings, setSettings } from '../core/settings';
import { DEFAULT_SETTINGS, type Settings } from '../core/types';
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

  <footer>
    Data generated from
    <a href="https://github.com/ethereum/EIPs" target="_blank" rel="noopener noreferrer">ethereum/EIPs</a>
    and
    <a href="https://github.com/ethereum/ERCs" target="_blank" rel="noopener noreferrer">ethereum/ERCs</a>,
    bundled with the extension. No network requests are made while you browse.
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
}
