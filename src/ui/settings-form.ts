import { getSettings, setSettings } from '../core/settings';
import type { Settings } from '../core/types';
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
  <h1>EIP Helper</h1>

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
        Matches <code>7702</code> with no <code>EIP-</code> prefix. Off by default:
        34 proposal numbers are also plausible years (2015, 2020, 2025, 2026…) and 91
        are under 1000. When on, only 4–5 digit numbers count, the page has to look
        Ethereum-related, and year, currency, and hex contexts are skipped.
      </small>
    </span>
  </label>

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

/** Renders the form into `root` and wires every control to storage. */
export async function mountSettingsForm(root: HTMLElement): Promise<void> {
  root.innerHTML = FORM;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;

  const enabled = $<HTMLInputElement>('enabled');
  const bareNumbers = $<HTMLInputElement>('bareNumbers');
  const includeUnmerged = $<HTMLInputElement>('includeUnmerged');
  const lookupOnSelection = $<HTMLInputElement>('lookupOnSelection');
  const debugMode = $<HTMLInputElement>('debugMode');
  const highlightStyle = $<HTMLSelectElement>('highlightStyle');
  const disabledSites = $<HTMLTextAreaElement>('disabledSites');
  const saved = $<HTMLParagraphElement>('saved');

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
  includeUnmerged.checked = settings.includeUnmerged;
  lookupOnSelection.checked = settings.lookupOnSelection;
  debugMode.checked = settings.debugMode;
  highlightStyle.value = settings.highlightStyle;
  disabledSites.value = settings.disabledSites.join('\n');

  enabled.addEventListener('change', () => void save({ enabled: enabled.checked }));
  bareNumbers.addEventListener('change', () => void save({ bareNumbers: bareNumbers.checked }));
  includeUnmerged.addEventListener('change', () => void save({ includeUnmerged: includeUnmerged.checked }));
  lookupOnSelection.addEventListener('change', () => void save({ lookupOnSelection: lookupOnSelection.checked }));
  debugMode.addEventListener('change', () => void save({ debugMode: debugMode.checked }));
  highlightStyle.addEventListener(
    'change',
    () => void save({ highlightStyle: highlightStyle.value as Settings['highlightStyle'] }),
  );
  disabledSites.addEventListener('change', () =>
    void save({
      disabledSites: disabledSites.value
        .split('\n')
        .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean),
    }),
  );
}
