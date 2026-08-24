/**
 * End-to-end verification of the built extension in a real Chromium browser.
 *
 * This exists because the load-bearing parts of this extension cannot be
 * tested in jsdom: the CSS Custom Highlight API, caret hit-testing, and the
 * claim that the page DOM is never mutated. Run `npm run build` first.
 *
 * Set CHROME_PATH to point at a specific Chromium binary.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Polls `fn` until it returns something truthy, or the timeout elapses. */
const waitFor = async (fn, ms, step = 250) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, step));
  }
};

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, '../../.output/chrome-mv3');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('No Chromium-based browser found. Set CHROME_PATH.');
  process.exit(1);
}
if (!existsSync(EXT)) {
  console.error(`Build output missing at ${EXT}. Run "npm run build" first.`);
  process.exit(1);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// Vite module-preload hints do not work across Chrome extension execution
// worlds. In particular, a shared popup/options chunk triggers Chrome's
// "cross-world extension resource mismatch" warning. Keep this assertion on
// built HTML so a Vite/WXT upgrade cannot quietly reintroduce it.
for (const file of ['popup.html', 'options.html']) {
  const html = await readFile(path.join(EXT, file), 'utf8');
  if (/<link\s+[^>]*rel=["']modulepreload["']/i.test(html)) {
    console.error(`FATAL: ${file} contains a modulepreload link.`);
    process.exit(1);
  }
}

// data/eips.json is pretty in git, but WXT/Vite embeds a compact JSON string in
// the production service worker. aliases.json is maintenance-only and must not
// be copied into the extension at all.
const builtBackground = await readFile(path.join(EXT, 'background.js'), 'utf8');
const compactBackground = builtBackground.endsWith('\n')
  ? builtBackground.slice(0, -1)
  : builtBackground;
if (compactBackground.includes('\n')) {
  console.error('FATAL: background.js does not contain the compact production dataset.');
  process.exit(1);
}
const shippedFiles = await readdir(EXT, { recursive: true });
if (shippedFiles.some((file) => path.basename(file) === 'aliases.json')) {
  console.error('FATAL: maintenance-only data/aliases.json was copied into the extension.');
  process.exit(1);
}
const aliasEntries = JSON.parse(
  await readFile(path.resolve(HERE, '../../data/aliases.json'), 'utf8'),
);
if (aliasEntries.some(({ reason }) => reason && builtBackground.includes(reason))) {
  console.error('FATAL: alias maintenance reasons were embedded in background.js.');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
check(
  'manifest permissions are exactly storage and alarms',
  JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'alarms']),
  JSON.stringify(manifest.permissions),
);
check(
  'manifest requires the storage access-level trust boundary',
  Number(manifest.minimum_chrome_version) >= 102,
  String(manifest.minimum_chrome_version),
);
check(
  'manifest adds no host, tabs, or web-accessible-resource permission',
  !Object.hasOwn(manifest, 'host_permissions') &&
    !manifest.permissions?.includes('tabs') &&
    !Object.hasOwn(manifest, 'web_accessible_resources'),
);
const forbiddenDatabaseOutputs = new Set([
  'database.signed.json',
  'database.payload.json',
  'database-public-key.json',
  'database-version.json',
]);
check(
  'signed/review/private database files are absent from extension output',
  !shippedFiles.some((file) =>
    forbiddenDatabaseOutputs.has(path.basename(file)) ||
    path.basename(file).endsWith('.pem') ||
    file.split(path.sep).includes('.secrets'),
  ),
);
const fixedDatabaseUrl =
  'https://api.github.com/repos/toml01/eipeek/contents/data/database.signed.json?ref=main';
const fixedVersionHintUrl =
  'https://api.github.com/repos/toml01/eipeek/contents/data/database-version.json?ref=main';
check(
  'background contains the fixed signed-database endpoint exactly once',
  builtBackground.split(fixedDatabaseUrl).length === 2,
);
check(
  'background contains the fixed version-hint endpoint exactly once',
  builtBackground.split(fixedVersionHintUrl).length === 2,
);
check(
  'background contains no private signing key',
  !builtBackground.includes('BEGIN PRIVATE KEY') && !builtBackground.includes('BEGIN EC PRIVATE KEY'),
);
const signedDatabaseArtifact = await readFile(
  path.resolve(HERE, '../../data/database.signed.json'),
  'utf8',
);

// Serve the fixture over http: content scripts do not run on file:// URLs
// unless the extension is granted file access.
const fixture = await readFile(path.join(HERE, 'fixture.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/`;

console.log(`browser: ${BROWSER}\nfixture: ${URL}\n`);

/** Drops the tooltip's inlined <style> text so the log stays readable. */
const summarize = (text) =>
  (text || '(empty)')
    .split(' | ')
    .filter((part) => !part.includes('{'))
    .join(' | ') || '(empty)';

const profile = await mkdtemp(path.join(tmpdir(), 'eipeek-e2e-'));

const COMMON_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  // Opt-in for locked-down containers that disable both user namespaces and
  // Chrome's setuid sandbox. Normal development/CI keeps the sandbox enabled.
  ...(process.env.EIPEEK_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
];
const HEADLESS = process.env.EIPEEK_E2E_HEADLESS === '1';

/**
 * Loads the unpacked extension, coping with the fact that there are now two
 * mechanisms and no single browser supports both well.
 *
 * Chrome 137 removed `--load-extension` from *branded* Chrome builds, because
 * malware abused it. It still works in Chromium, Chrome for Testing and other
 * Chromium forks (Brave, Edge). The replacement is the CDP
 * `Extensions.loadUnpacked` command, which puppeteer exposes as
 * `browser.installExtension` and which requires pipe transport plus
 * `--enable-unsafe-extension-debugging`.
 *
 * So: try the modern path first, and fall back to the flag.
 */
async function launchWithExtension() {
  try {
    const browser = await puppeteer.launch({
      executablePath: BROWSER,
      headless: HEADLESS,
      userDataDir: profile,
      // Extensions.loadUnpacked is only exposed over a pipe connection.
      pipe: true,
      // Keeps puppeteer from adding --disable-extensions.
      enableExtensions: true,
      args: ['--enable-unsafe-extension-debugging', ...COMMON_ARGS],
    });
    const id = await browser.installExtension(EXT);
    console.log(`loaded via Extensions.loadUnpacked (id ${id})`);
    return browser;
  } catch (err) {
    console.log(`Extensions.loadUnpacked unavailable (${String(err).split('\n')[0]});`);
    console.log('falling back to --load-extension');
    return puppeteer.launch({
      executablePath: BROWSER,
      headless: HEADLESS,
      userDataDir: `${profile}-legacy`,
      enableExtensions: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...COMMON_ARGS],
    });
  }
}

const browser = await launchWithExtension();

try {
  // Confirm the extension actually loaded before asserting anything about it.
  // Without this, every "not matched" check below passes vacuously when the
  // extension is absent -- nothing matches, so nothing is wrongly matched.
  const worker = await waitFor(
    async () =>
      (await browser.targets()).find(
        (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      ),
    25000,
  );
  if (!worker) {
    console.error('FATAL: the extension service worker never appeared. Targets seen:');
    for (const t of await browser.targets()) {
      console.error(`  ${t.type()}  ${t.url().slice(0, 90)}`);
    }
    process.exit(1);
  }
  console.log(`extension worker: ${worker.url()}\n`);
  // Regex rather than the URL constructor: the fixture's own `URL` constant
  // shadows the global one in this module.
  const extensionId = /^chrome-extension:\/\/([a-z]+)\//.exec(worker.url())?.[1];

  // Observe the service worker before opening any extension page or fixture.
  // The only matching request must be the one released after the explicit
  // Check button click below.
  const workerCdp = await worker.createCDPSession();
  await workerCdp.send('Network.enable');
  const databaseNetworkRequests = [];
  workerCdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('/data/database.signed.json') || request.url.includes('/data/database-version.json')) {
      databaseNetworkRequests.push({ url: request.url, method: request.method, headers: request.headers });
    }
  });

  // --- Extension pages: feedback opens the repository issue form --------
  const feedbackIssueUrl = 'https://github.com/toml01/eipeek/issues/new?template=feedback.yml';
  for (const extensionPage of ['popup.html', 'options.html']) {
    const extensionPageTab = await browser.newPage();
    await extensionPageTab.goto(`chrome-extension://${extensionId}/${extensionPage}`);
    await extensionPageTab.waitForSelector('[data-testid="feedback-link"]');
    await extensionPageTab.waitForSelector('#databaseSection[aria-busy="false"]');
    await waitFor(
      () => extensionPageTab.$eval('#databaseNextCheck', (node) =>
        !['—', 'Scheduling…'].includes(node.textContent?.trim()) ? node.textContent.trim() : undefined).catch(() => undefined),
      8000,
      100,
    );
    const databaseUi = await extensionPageTab.evaluate(() => ({
      heading: document.querySelector('#database-heading')?.textContent?.trim(),
      source: document.querySelector('#databaseSource')?.textContent?.trim(),
      version: document.querySelector('#databaseVersion')?.textContent?.trim(),
      lastCheck: document.querySelector('#databaseLastCheck')?.textContent?.trim(),
      nextCheck: document.querySelector('#databaseNextCheck')?.textContent?.trim(),
      autoChecked: document.querySelector('[data-testid="database-auto-update"]')?.checked,
      checkText: document.querySelector('[data-testid="database-check"]')?.textContent?.trim(),
      checkDisabled: document.querySelector('[data-testid="database-check"]')?.disabled,
      restoreText: document.querySelector('[data-testid="database-restore"]')?.textContent?.trim(),
      restoreDisabled: document.querySelector('[data-testid="database-restore"]')?.disabled,
      messageRole: document.querySelector('[data-testid="database-message"]')?.getAttribute('role'),
      messageLive: document.querySelector('[data-testid="database-message"]')?.getAttribute('aria-live'),
    }));
    check(
      `${extensionPage} shows bundled database status and both manual actions`,
      databaseUi.heading === 'Database' &&
        databaseUi.source === 'Bundled fallback' &&
        databaseUi.version === '2026082401' &&
        databaseUi.lastCheck === 'Never' &&
        databaseUi.autoChecked === true &&
        !['—', 'Scheduling…', 'Disabled'].includes(databaseUi.nextCheck) &&
        databaseUi.checkText === 'Check for updates' &&
        databaseUi.checkDisabled === false &&
        databaseUi.restoreText === 'Restore bundled database' &&
        databaseUi.restoreDisabled === true,
      JSON.stringify(databaseUi),
    );
    check(
      `${extensionPage} database action state is an accessible live region`,
      databaseUi.messageRole === 'status' && databaseUi.messageLive === 'polite',
      `${databaseUi.messageRole} ${databaseUi.messageLive}`,
    );
    const feedbackLink = await extensionPageTab.$eval('[data-testid="feedback-link"]', (link) => ({
      href: link.href,
      target: link.target,
      rel: link.rel,
    }));
    check(`${extensionPage} links to the feedback issue draft`, feedbackLink.href === feedbackIssueUrl, feedbackLink.href);
    check(
      `${extensionPage} feedback link opens safely in a new tab`,
      feedbackLink.target === '_blank' && feedbackLink.rel.includes('noopener') && feedbackLink.rel.includes('noreferrer'),
      `${feedbackLink.target} ${feedbackLink.rel}`,
    );
    check(
      `${extensionPage} has no mailto feedback form`,
      (await extensionPageTab.$$('[href^="mailto:"], #feedbackCategory, #feedbackMessage')).length === 0,
    );

    if (extensionPage === 'popup.html') {
      const targetsBeforeClick = new Set(await browser.targets());
      await extensionPageTab.click('[data-testid="feedback-link"]');
      const opened = await waitFor(
        async () =>
          (await browser.targets()).find(
            (target) => !targetsBeforeClick.has(target) && target.type() === 'page',
          ),
        8000,
      );
      const openedUrl = opened?.url() ?? '';
      const redirectedToLogin = (() => {
        if (!openedUrl.startsWith('https://github.com/login?')) return false;
        const returnTo = new globalThis.URL(openedUrl).searchParams.get('return_to');
        return returnTo === feedbackIssueUrl;
      })();
      check(
        'clicking feedback opens the GitHub issue draft',
        openedUrl === feedbackIssueUrl || redirectedToLogin,
        openedUrl || 'no new tab',
      );
      if (opened) await (await opened.page())?.close();
    }

    await extensionPageTab.close();
  }

  // The preference defaults on, survives in sync storage, and controls only the
  // named alarm. Disable it for the long browse tests so randomized delivery
  // cannot make their no-request assertions timing-dependent.
  const alarmSettingsTab = await browser.newPage();
  await alarmSettingsTab.goto(`chrome-extension://${extensionId}/options.html`);
  await alarmSettingsTab.waitForSelector('#databaseSection[aria-busy="false"]');
  const initialAlarm = await alarmSettingsTab.evaluate(async () => ({
    preference: (await chrome.storage.sync.get('eipeek.database.autoUpdate.v1'))['eipeek.database.autoUpdate.v1'],
    alarm: await chrome.alarms.get('eipeek.database.daily.v1'),
  }));
  check(
    'daily checks default on with a scheduled 1440-minute alarm',
    initialAlarm.preference === undefined &&
      initialAlarm.alarm?.periodInMinutes === 1440 &&
      initialAlarm.alarm?.scheduledTime > Date.now(),
    JSON.stringify(initialAlarm),
  );
  await alarmSettingsTab.$eval('[data-testid="database-auto-update"]', (input) => input.click());
  const disabledSchedule = await waitFor(
    () => alarmSettingsTab.evaluate(async () => {
      const next = document.querySelector('#databaseNextCheck')?.textContent?.trim();
      const alarm = await chrome.alarms.get('eipeek.database.daily.v1');
      return next === 'Disabled' && !alarm ? { next, checked: document.querySelector('[data-testid="database-auto-update"]')?.checked } : undefined;
    }),
    8000,
    100,
  );
  check('disabling automatic checks clears the daily alarm', disabledSchedule?.checked === false, JSON.stringify(disabledSchedule));
  await alarmSettingsTab.$eval('[data-testid="database-auto-update"]', (input) => input.click());
  const recreatedSchedule = await waitFor(
    () => alarmSettingsTab.evaluate(async () => {
      const alarm = await chrome.alarms.get('eipeek.database.daily.v1');
      return alarm?.periodInMinutes === 1440 ? alarm : undefined;
    }),
    8000,
    100,
  );
  check('re-enabling automatic checks recreates the daily alarm', !!recreatedSchedule, JSON.stringify(recreatedSchedule));
  await alarmSettingsTab.$eval('[data-testid="database-auto-update"]', (input) => input.click());
  await waitFor(() => alarmSettingsTab.$eval('#databaseNextCheck', (node) => node.textContent?.trim() === 'Disabled'), 8000, 100);
  await alarmSettingsTab.close();

  /** Settings live behind the extension origin, so drive them from its own page. */
  const setSetting = async (patch) => {
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extensionId}/options.html`);
    await opts.evaluate((p) => chrome.storage.sync.set(p), patch);
    await opts.close();
    // Opening another page backgrounds the fixture, which starves its
    // requestIdleCallback and so its rescan; put it back in front.
    await page.bringToFront();
    // Let the content script's storage.onChanged listener catch up.
    await new Promise((r) => setTimeout(r, 700));
  };

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const pageCdp = await page.createCDPSession();
  const executionContexts = new Map();
  pageCdp.on('Runtime.executionContextCreated', ({ context }) => {
    executionContexts.set(context.id, context);
  });
  pageCdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    executionContexts.delete(executionContextId);
  });
  pageCdp.on('Runtime.executionContextsCleared', () => {
    executionContexts.clear();
  });
  await pageCdp.send('Runtime.enable');

  // Capture the pristine DOM before the content script runs.
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const domBefore = await page.evaluate(() => document.body.innerHTML);

  await page.goto(URL, { waitUntil: 'networkidle2' });

  // Poll rather than sleep a fixed time: CI runners are slow, and a fixed wait
  // either flakes or wastes time.
  const ranges = await waitFor(
    async () => {
      const n = await page.evaluate(() => CSS.highlights?.get('eip-ref')?.size ?? 0);
      return n > 0 ? n : undefined;
    },
    20000,
  );
  if (!ranges) {
    console.error('FATAL: no highlights registered after 20s -- the content script did not run.');
    process.exit(1);
  }

  const findContentContext = () =>
    [...executionContexts.values()].find(
      (context) =>
        (context.origin === `chrome-extension://${extensionId}` ||
          context.name?.includes(extensionId)) &&
        context.auxData?.type === 'isolated',
    );
  const contentContext = await waitFor(findContentContext, 8000, 100);
  const evaluateInContentContext = async (expression) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const currentContentContext = findContentContext();
      if (currentContentContext) {
        try {
          const result = await pageCdp.send('Runtime.evaluate', {
            contextId: currentContentContext.id,
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (!result.exceptionDetails) return result.result.value;
        } catch (error) {
          if (!/Cannot find context|Execution context was destroyed/.test(error?.message)) throw error;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  };
  const storageListenerInstalled = await evaluateInContentContext(`(() => {
    globalThis.__eipeekDatabaseStorageEvents = [];
    chrome.storage.onChanged.addListener((changes, areaName) => {
      globalThis.__eipeekDatabaseStorageEvents.push({
        areaName,
        keys: Object.keys(changes).sort(),
        bytes: new TextEncoder().encode(JSON.stringify(changes)).byteLength,
      });
    });
    return true;
  })()`);
  check(
    'real content-script world can observe the activation channel for the storage boundary test',
    storageListenerInstalled === true,
    contentContext ? JSON.stringify({ origin: contentContext.origin, name: contentContext.name }) : 'no context',
  );
  check(
    'startup, status rendering, page scanning, and hover setup make no database request',
    databaseNetworkRequests.length === 0,
    JSON.stringify(databaseNetworkRequests),
  );

  // --- 1. the APIs this design depends on -------------------------------
  const api = await page.evaluate(() => ({
    highlights: !!CSS?.highlights && typeof Highlight !== 'undefined',
    caret:
      typeof document.caretPositionFromPoint === 'function' ||
      typeof document.caretRangeFromPoint === 'function',
    // Present but non-functional in this build -- recorded, not required.
    hitTestApi: typeof CSS?.highlights?.highlightsFromPoint === 'function',
  }));
  check('CSS Custom Highlight API available', api.highlights);
  check('caret hit-testing available', api.caret);
  console.log(`      (highlightsFromPoint present: ${api.hitTestApi})`);

  // --- 2. highlights registered ----------------------------------------
  const hl = await page.evaluate(() => {
    const h = CSS.highlights.get('eip-ref');
    if (!h) return null;
    return [...h].map((r) => r.toString());
  });
  check('highlight registered', Array.isArray(hl) && hl.length > 0, `${hl?.length ?? 0} ranges`);
  if (!hl?.length) {
    console.error('FATAL: highlight vanished between polls; aborting to avoid vacuous passes.');
    process.exit(1);
  }

  const texts = hl ?? [];
  const has = (t) => texts.includes(t);

  // --- 3. Tier 1 forms --------------------------------------------------
  check('matches EIP-7702', has('EIP-7702'));
  check('matches EIP-2718', has('EIP-2718'));
  check('matches EIP7702 (no separator)', has('EIP7702'));
  check('matches "eip 7702" (space)', has('eip 7702'));
  check('matches ERC-20', has('ERC-20'));
  check('matches ERC-4337 written as EIP-4337', has('EIP-4337'));

  // Plural prefix + list continuation: "EIPs 3074 and 7702"
  check('matches plural prefix "EIPs 3074"', has('EIPs 3074') || has('EIPs 3074'.trim()));
  check(
    'matches list continuation (bare 7702 after "and")',
    texts.filter((t) => t === '7702').length >= 1,
    `${texts.filter((t) => t === '7702').length} bare 7702`,
  );
  // "ERC721s" -- trailing plural trimmed off the highlight
  check('trims trailing plural (ERC721 not ERC721s)', has('ERC721') && !has('ERC721s'));

  // --- 4. false positives NOT highlighted -------------------------------
  const scoped = async (sel) =>
    page.evaluate((s) => {
      const h = CSS.highlights.get('eip-ref');
      if (!h) return [];
      const el = document.querySelector(s);
      return [...h]
        .filter((r) => el.contains(r.startContainer))
        .map((r) => r.toString());
    }, sel);

  check('bare number not matched by default', (await scoped('#bare')).length === 0);
  check('years never matched', (await scoped('#years')).length === 0, JSON.stringify(await scoped('#years')));
  check('currency/quantities not matched', (await scoped('#amounts')).length === 0, JSON.stringify(await scoped('#amounts')));
  check('slugs and hex not matched', (await scoped('#slug')).length === 0, JSON.stringify(await scoped('#slug')));
  // Deliberately inverted from the original expectation: a reference that is
  // already a link to the spec is still worth decorating, because the tooltip
  // shows the title and status that the link text does not. See #google-result.
  check(
    'reference that is already a spec link is still decorated',
    (await scoped('#alreadylinked')).includes('EIP-1559'),
    JSON.stringify(await scoped('#alreadylinked')),
  );
  check(
    'Google search result title is decorated',
    (await scoped('#google-result')).some((t) => t.replace(/\s+/g, '') === 'EIP-8081'),
    JSON.stringify(await scoped('#google-result')),
  );
  check(
    'never assembles a reference across a tight block exit',
    (await scoped('#block-exit-tight')).length === 0,
    JSON.stringify(await scoped('#block-exit-tight')),
  );
  check(
    'never assembles a reference across a block exit',
    (await scoped('#block-exit')).length === 0,
    JSON.stringify(await scoped('#block-exit')),
  );
  check('contenteditable skipped', (await scoped('#editable')).length === 0);

  // --- 4b. references split across inline elements ----------------------
  // X search bolds the matched term, splitting "EIP-7702" into three text
  // nodes. Matching has to join inline runs to see it.
  check(
    'matches a reference split across spans (X search)',
    (await scoped('#x-search')).some((t) => t.replace(/\s+/g, '') === 'EIP-7702'),
    JSON.stringify(await scoped('#x-search')),
  );
  check(
    'matches a split reference with no separator (ERC + 20)',
    (await scoped('#x-search-2')).some((t) => t.replace(/\s+/g, '') === 'ERC20'),
    JSON.stringify(await scoped('#x-search-2')),
  );
  // The safety property that makes joining acceptable.
  check(
    'never assembles a reference across a block boundary',
    (await scoped('#block-boundary')).length === 0,
    JSON.stringify(await scoped('#block-boundary')),
  );

  // --- 5. the core claim: no DOM mutation -------------------------------
  const domAfter = await page.evaluate(() => {
    // Exclude the extension's own tooltip host, the one element it adds.
    const clone = document.body.cloneNode(true);
    for (const child of [...clone.children]) {
      if (child.tagName === 'DIV' && child.getAttribute('style')?.includes('2147483647')) {
        child.remove();
      }
    }
    return clone.innerHTML;
  });
  check(
    'page DOM is byte-identical (no span wrapping)',
    domBefore === domAfter,
    domBefore === domAfter ? '' : 'DOM changed!',
  );

  // --- 6. hover shows the tooltip with real metadata --------------------
  // `steps` emits a stream of mousemove events, the way a real pointer does; a
  // single synthetic move is not a fair simulation of hovering.
  const hover = async (pt) => {
    await page.mouse.move(pt.x - 60, pt.y, { steps: 3 });
    await page.mouse.move(pt.x, pt.y, { steps: 6 });
  };

  // The tooltip lives in a CLOSED shadow root, so JS in the page cannot reach
  // it. Pierce it over CDP instead.
  const cdp = await page.createCDPSession();
  // Collect text from INSIDE shadow roots only -- collecting the whole document
  // would match the fixture's own page text and pass vacuously.
  const collect = (node, out = [], inShadow = false) => {
    if (inShadow && node.nodeValue?.trim()) out.push(node.nodeValue.trim());
    for (const c of node.children ?? []) collect(c, out, inShadow);
    for (const s of node.shadowRoots ?? []) collect(s, out, true);
    return out;
  };
  const shadowOf = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    return collect(root).join(' | ');
  };
  const attributesOf = (node) =>
    Object.fromEntries(
      Array.from({ length: (node.attributes ?? []).length / 2 }, (_, i) => [
        node.attributes[i * 2],
        node.attributes[i * 2 + 1],
      ]),
    );
  const findTooltipTestNodes = async (testid) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const found = [];
    const visit = (node) => {
      const attrs = attributesOf(node);
      if (attrs['data-testid'] === testid) {
        found.push({ ...attrs, text: collect(node, [], true).join(' ') });
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        visit(child);
      }
    };
    visit(root);
    return found;
  };
  const findTooltipTestNode = async (testid) => (await findTooltipTestNodes(testid))[0] ?? null;
  /** True when the extension's tooltip host is actually displayed. */
  const tooltipVisible = () =>
    page.evaluate(() =>
      [...document.body.children].some(
        (c) =>
          (c.getAttribute('style') ?? '').includes('2147483647') && c.style.display === 'block',
      ),
    );

  /**
   * Polls rather than sleeping a fixed time, so the check is not timing-fragile.
   *
   * Gated on visibility, which matters: hiding the tooltip only sets
   * `display: none` and leaves the previous entry's text in the shadow root, so
   * reading it unconditionally can match stale content from an earlier hover.
   */
  const waitForTooltip = async (needle, ms = 6000) => {
    const deadline = Date.now() + ms;
    let last = '';
    for (;;) {
      if (await tooltipVisible()) {
        last = await shadowOf();
        if (last.includes(needle)) return last;
      }
      if (Date.now() >= deadline) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /**
   * Hovers the first reference inside `sel`. Every hover check goes through this
   * so they all get the same treatment: scroll into view (the fixture is taller
   * than the viewport), park the pointer clear of any highlight and wait out the
   * hide grace period so stale content cannot satisfy the next assertion, then
   * re-nudge once if the tooltip has not appeared -- CI runners are slow enough
   * that a first metadata lookup can outlast the dwell.
   */
  const hoverIn = async (sel) => {
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
    await new Promise((r) => setTimeout(r, 400));
    const pt = await page.evaluate((s) => {
      const h = CSS.highlights.get('eip-ref');
      const el = document.querySelector(s);
      const range = [...h].find((r) => el.contains(r.startContainer));
      if (!range) return null;
      const b = range.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, sel);
    if (!pt) return null;

    await page.mouse.move(5, 5, { steps: 2 });
    await new Promise((r) => setTimeout(r, 400));
    await hover(pt);
    if (!(await waitFor(tooltipVisible, 2500))) await hover(pt);
    return pt;
  };

  await hoverIn('#prefixed');
  const shadowText = await waitForTooltip('Set Code for EOAs');
  console.log(`      tooltip: ${summarize(shadowText)}`);

  check(
    'tooltip shows canonical label',
    shadowText.includes('EIP-7702') && shadowText.includes('Set Code for EOAs'),
  );
  check('tooltip shows the title', shadowText.includes('Set Code for EOAs'));
  check('tooltip shows status and category', shadowText.includes('Final') && shadowText.includes('Core'));
  check(
    'tooltip shows an included upgrade inline in the header',
    shadowText.includes('Pectra') &&
      !shadowText.includes('Upgrade:') &&
      shadowText.indexOf('Pectra') < shadowText.indexOf('Set Code for EOAs'),
  );
  const pectraUpgradeLink = await findTooltipTestNode('tooltip-upgrade-link');
  check(
    'included upgrade links safely to its Meta EIP',
    pectraUpgradeLink?.text === 'Pectra' &&
      pectraUpgradeLink.href === 'https://eips.ethereum.org/EIPS/eip-7600' &&
      pectraUpgradeLink.target === '_blank' &&
      pectraUpgradeLink.rel?.includes('noopener') &&
      pectraUpgradeLink.rel?.includes('noreferrer'),
    JSON.stringify(pectraUpgradeLink),
  );
  check('tooltip shows links', ['Spec', 'Discussion', 'Source', 'Mistake?'].every((l) => shadowText.includes(l)));
  const tooltipFeedbackLink = await findTooltipTestNode('tooltip-feedback-link');
  check(
    'tooltip mistake link targets the feedback issue draft safely',
    tooltipFeedbackLink?.href === feedbackIssueUrl &&
      tooltipFeedbackLink.target === '_blank' &&
      tooltipFeedbackLink.rel?.includes('noopener') &&
      tooltipFeedbackLink.rel?.includes('noreferrer'),
    JSON.stringify(tooltipFeedbackLink),
  );
  check(
    'tooltip contains no database source, version, or update indicator',
    !shadowText.includes('Bundled fallback') &&
      !shadowText.includes('Downloaded and signature-verified') &&
      !shadowText.includes('Check for updates') &&
      !shadowText.includes('2026082401'),
  );
  check(
    'page hover makes no database request',
    databaseNetworkRequests.length === 0,
    JSON.stringify(databaseNetworkRequests),
  );

  // --- 6b. explicit, fixed-URL database actions -------------------------
  // Intercept the one compile-time endpoint in the worker itself. This proves
  // the real browser flow without relying on GitHub or whatever happens to be
  // on main while this feature branch is under test.
  const interceptedDatabaseRequests = [];
  let nextResponseBody = signedDatabaseArtifact;
  const versionHintBody = `${JSON.stringify({
    schemaVersion: 1,
    databaseVersion: 2026082401,
    keyId: 'eipeek-database-p256-2026-01',
  }, null, 2)}\n`;
  let releaseResponse = () => {};
  let responseGate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let nextPaused;
  const onDatabaseRequestPaused = async (event) => {
    if (event.request.url !== fixedDatabaseUrl && event.request.url !== fixedVersionHintUrl) {
      await workerCdp.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    const body = event.request.url === fixedVersionHintUrl ? versionHintBody : nextResponseBody;
    const gate = responseGate;
    const notify = nextPaused;
    nextPaused = undefined;
    interceptedDatabaseRequests.push({
      url: event.request.url,
      method: event.request.method,
      headers: event.request.headers,
    });
    notify?.(interceptedDatabaseRequests.at(-1));
    await gate;
    await workerCdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/vnd.github.raw+json' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(body).toString('base64'),
    });
  };
  workerCdp.on('Fetch.requestPaused', onDatabaseRequestPaused);
  await workerCdp.send('Fetch.enable', {
    patterns: [
      {
        urlPattern:
          'https://api.github.com/repos/toml01/eipeek/contents/data/database.signed.json*',
        requestStage: 'Request',
      },
      {
        urlPattern:
          'https://api.github.com/repos/toml01/eipeek/contents/data/database-version.json*',
        requestStage: 'Request',
      },
    ],
  });

  const updateTab = await browser.newPage();
  await updateTab.goto(`chrome-extension://${extensionId}/options.html`);
  await updateTab.waitForSelector('#databaseSection[aria-busy="false"]');
  const concurrentStatusTab = await browser.newPage();
  await concurrentStatusTab.goto(`chrome-extension://${extensionId}/popup.html`);
  await concurrentStatusTab.waitForSelector('#databaseSection[aria-busy="false"]');
  const firstPaused = new Promise((resolve) => {
    nextPaused = resolve;
  });
  await updateTab.$eval('[data-testid="database-check"]', (button) => button.click());
  const firstRequest = await Promise.race([
    firstPaused,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
  ]);
  const busyUi = await updateTab.evaluate(() => ({
    busy: document.querySelector('#databaseSection')?.getAttribute('aria-busy'),
    checkDisabled: document.querySelector('[data-testid="database-check"]')?.disabled,
    restoreDisabled: document.querySelector('[data-testid="database-restore"]')?.disabled,
    message: document.querySelector('[data-testid="database-message"]')?.textContent?.trim(),
    role: document.querySelector('[data-testid="database-message"]')?.getAttribute('role'),
  }));
  check(
    'Check click exposes an accessible busy state while the request is in flight',
    busyUi.busy === 'true' &&
      busyUi.checkDisabled === true &&
      busyUi.restoreDisabled === true &&
      busyUi.message === 'Checking GitHub for a signed database…' &&
      busyUi.role === 'status',
    JSON.stringify(busyUi),
  );
  releaseResponse();

  const updateSuccess = await waitFor(
    () =>
      updateTab
        .$eval('[data-testid="database-message"]', (node) =>
          node.textContent?.includes('Verified and activated database') ? node.textContent : undefined,
        )
        .catch(() => undefined),
    15000,
    100,
  );
  const activatedUi = await updateTab.evaluate(() => ({
    source: document.querySelector('#databaseSource')?.textContent?.trim(),
    version: document.querySelector('#databaseVersion')?.textContent?.trim(),
    restoreDisabled: document.querySelector('[data-testid="database-restore"]')?.disabled,
    role: document.querySelector('[data-testid="database-message"]')?.getAttribute('role'),
  }));
  check(
    'valid signed response activates through the real settings UI',
    !!updateSuccess &&
      activatedUi.source === 'Downloaded and signature-verified' &&
      activatedUi.version === '2026082401' &&
      activatedUi.restoreDisabled === false &&
      activatedUi.role === 'status',
    JSON.stringify({ updateSuccess, activatedUi }),
  );
  const concurrentActivatedUi = await waitFor(
    () =>
      concurrentStatusTab
        .evaluate(() => {
          const source = document.querySelector('#databaseSource')?.textContent?.trim();
          const version = document.querySelector('#databaseVersion')?.textContent?.trim();
          const restoreDisabled = document.querySelector('[data-testid="database-restore"]')?.disabled;
          return source === 'Downloaded and signature-verified'
            ? { source, version, restoreDisabled }
            : undefined;
        })
        .catch(() => undefined),
    8000,
    100,
  );
  check(
    'concurrently open settings surface refreshes after activation',
    concurrentActivatedUi?.version === '2026082401' && concurrentActivatedUi.restoreDisabled === false,
    JSON.stringify(concurrentActivatedUi),
  );
  const contentStorageEvents = await evaluateInContentContext(
    'structuredClone(globalThis.__eipeekDatabaseStorageEvents)',
  );
  check(
    'content listener receives only the small session activation signal, never local artifact changes',
    Array.isArray(contentStorageEvents) &&
      contentStorageEvents.length === 1 &&
      contentStorageEvents[0].areaName === 'session' &&
      JSON.stringify(contentStorageEvents[0].keys) ===
        JSON.stringify(['eipeek.database.activation.v1']) &&
      contentStorageEvents[0].bytes < 256,
    JSON.stringify(contentStorageEvents),
  );
  const requestHeaders = Object.fromEntries(
    Object.entries(firstRequest?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  check(
    'manual check uses only the fixed raw Contents request without credentials',
    firstRequest?.url === fixedDatabaseUrl &&
      firstRequest?.method === 'GET' &&
      requestHeaders.accept === 'application/vnd.github.raw+json' &&
      !requestHeaders.authorization &&
      !requestHeaders.cookie,
    JSON.stringify(firstRequest),
  );
  await waitFor(async () => !(await tooltipVisible()), 6000, 100);
  check('database activation hides an open tooltip', !(await tooltipVisible()));

  const requestsBeforeRestore = interceptedDatabaseRequests.length;
  await updateTab.$eval('[data-testid="database-restore"]', (button) => button.click());
  const restoreSuccess = await waitFor(
    () =>
      updateTab
        .$eval('[data-testid="database-message"]', (node) =>
          node.textContent?.includes('Restored bundled database') ? node.textContent : undefined,
        )
        .catch(() => undefined),
    8000,
    100,
  );
  const restoredUi = await updateTab.evaluate(() => ({
    source: document.querySelector('#databaseSource')?.textContent?.trim(),
    restoreDisabled: document.querySelector('[data-testid="database-restore"]')?.disabled,
  }));
  check(
    'Restore selects bundled data without making a request',
    !!restoreSuccess &&
      restoredUi.source === 'Bundled fallback' &&
      restoredUi.restoreDisabled === true &&
      interceptedDatabaseRequests.length === requestsBeforeRestore,
    JSON.stringify({ restoreSuccess, restoredUi, requests: interceptedDatabaseRequests.length }),
  );
  const concurrentRestoredUi = await waitFor(
    () =>
      concurrentStatusTab
        .$eval('#databaseSource', (node) =>
          node.textContent?.trim() === 'Bundled fallback' ? node.textContent.trim() : undefined,
        )
        .catch(() => undefined),
    8000,
    100,
  );
  check(
    'concurrently open settings surface refreshes after restore',
    concurrentRestoredUi === 'Bundled fallback',
    concurrentRestoredUi,
  );

  // A safely mocked malformed response exercises the visible error state and
  // verifies that failure cannot dislodge the restored bundled fallback.
  nextResponseBody = '{"not":"a signed database"}\n';
  responseGate = Promise.resolve();
  const invalidPaused = new Promise((resolve) => {
    nextPaused = resolve;
  });
  await updateTab.$eval('[data-testid="database-check"]', (button) => button.click());
  await Promise.race([
    invalidPaused,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
  ]);
  const updateError = await waitFor(
    () =>
      updateTab
        .$eval('[data-testid="database-message"]', (node) =>
          node.getAttribute('role') === 'alert' && node.textContent?.trim()
            ? { message: node.textContent.trim(), role: node.getAttribute('role') }
            : undefined,
        )
        .catch(() => undefined),
    8000,
    100,
  );
  const failedUiSource = await updateTab.$eval('#databaseSource', (node) => node.textContent?.trim());
  check(
    'invalid update reports an accessible error and leaves bundled data active',
    updateError?.role === 'alert' && failedUiSource === 'Bundled fallback',
    JSON.stringify({ updateError, failedUiSource }),
  );

  // Trigger the real worker alarm path with a short-lived test alarm. The hint
  // equals the durable high-water version retained across Restore, so automatic
  // checking must record success without fetching/reactivating the artifact.
  const artifactRequestsBeforeAutomatic = interceptedDatabaseRequests.filter(({ url }) => url === fixedDatabaseUrl).length;
  await updateTab.$eval('[data-testid="database-auto-update"]', (input) => input.click());
  await waitFor(
    () => updateTab.evaluate(async () => (await chrome.alarms.get('eipeek.database.daily.v1'))?.periodInMinutes === 1440),
    8000,
    100,
  );
  const concurrentEnabledSchedule = await waitFor(
    () => concurrentStatusTab.evaluate(() => {
      const checked = document.querySelector('[data-testid="database-auto-update"]')?.checked;
      const next = document.querySelector('#databaseNextCheck')?.textContent?.trim();
      return checked && next !== 'Disabled' ? { checked, next } : undefined;
    }).catch(() => undefined),
    8000,
    100,
  );
  check(
    'concurrently open settings surface refreshes after schedule changes',
    concurrentEnabledSchedule?.checked === true,
    JSON.stringify(concurrentEnabledSchedule),
  );
  await updateTab.evaluate(() => chrome.alarms.create('eipeek.database.daily.v1', { when: Date.now() + 100 }));
  const automaticSuccess = await waitFor(
    () => updateTab.evaluate(() => {
      const result = document.querySelector('#databaseLastResult')?.textContent?.trim();
      const last = document.querySelector('#databaseLastCheck')?.textContent?.trim();
      return result?.includes('Automatic check found no version newer') ? { result, last } : undefined;
    }),
    12000,
    100,
  );
  const automaticHintRequests = interceptedDatabaseRequests.filter(({ url }) => url === fixedVersionHintUrl);
  const artifactRequestsAfterAutomatic = interceptedDatabaseRequests.filter(({ url }) => url === fixedDatabaseUrl).length;
  const automaticState = await updateTab.evaluate(async () => ({
    source: document.querySelector('#databaseSource')?.textContent?.trim(),
    next: document.querySelector('#databaseNextCheck')?.textContent?.trim(),
    alarm: await chrome.alarms.get('eipeek.database.daily.v1'),
  }));
  const concurrentAutomaticResult = await waitFor(
    () => concurrentStatusTab.$eval('#databaseLastResult', (node) =>
      node.textContent?.includes('Automatic check found no version newer') ? node.textContent.trim() : undefined).catch(() => undefined),
    8000,
    100,
  );
  check(
    'matching alarm performs the fixed hint check and preserves restore intent',
    !!automaticSuccess &&
      automaticHintRequests.length === 1 &&
      artifactRequestsAfterAutomatic === artifactRequestsBeforeAutomatic &&
      automaticState.source === 'Bundled fallback' &&
      automaticState.alarm?.periodInMinutes === 1440 &&
      !!concurrentAutomaticResult,
    JSON.stringify({ automaticSuccess, automaticState, concurrentAutomaticResult, requests: interceptedDatabaseRequests }),
  );
  await workerCdp.send('Fetch.disable');
  workerCdp.off('Fetch.requestPaused', onDatabaseRequestPaused);
  await concurrentStatusTab.close();
  await updateTab.close();
  await page.bringToFront();
  const rangesAfterRestore = await waitFor(
    () => page.evaluate(() => CSS.highlights.get('eip-ref')?.size ?? 0),
    6000,
    100,
  );
  check('activation and restore rescan without losing highlights', rangesAfterRestore > 0);

  await hoverIn('#scheduled-upgrade');
  const scheduledUpgradeText = await waitForTooltip('ETH transfers emit a log');
  console.log(`      tooltip: ${summarize(scheduledUpgradeText)}`);
  check(
    'tooltip shows a scheduled upgrade inline in the header',
    scheduledUpgradeText.includes('Glamsterdam') &&
      !scheduledUpgradeText.includes('Upgrade:') &&
      scheduledUpgradeText.indexOf('Glamsterdam') <
        scheduledUpgradeText.indexOf('ETH transfers emit a log'),
  );
  const scheduledUpgradeLink = await findTooltipTestNode('tooltip-upgrade-link');
  check(
    'scheduled upgrade is linked, italicized, and accessibly labelled',
    scheduledUpgradeLink?.text === 'Glamsterdam' &&
      scheduledUpgradeLink.href === 'https://eips.ethereum.org/EIPS/eip-7773' &&
      scheduledUpgradeLink.class?.split(' ').includes('scheduled') &&
      scheduledUpgradeLink['aria-label'] === 'Glamsterdam (scheduled)' &&
      scheduledUpgradeLink.title === 'Glamsterdam (scheduled)',
    JSON.stringify(scheduledUpgradeLink),
  );

  await hoverIn('#multiple-upgrades');
  const multipleUpgradeText = await waitForTooltip('Blob Parameter Only Hardforks');
  const multipleUpgradeLinks = await findTooltipTestNodes('tooltip-upgrade-link');
  const multipleUpgradeIcons = await findTooltipTestNodes('tooltip-upgrade-icon');
  check(
    'multiple upgrades share one icon and retain chronological link order',
    multipleUpgradeText.indexOf('Fusaka') < multipleUpgradeText.indexOf('BPO1') &&
      multipleUpgradeText.indexOf('BPO1') < multipleUpgradeText.indexOf('BPO2') &&
      multipleUpgradeText.includes('Fusaka | , | BPO1 | , | BPO2') &&
      multipleUpgradeLinks.map(({ text }) => text).join(', ') === 'Fusaka, BPO1, BPO2' &&
      multipleUpgradeIcons.length === 1,
    JSON.stringify({ links: multipleUpgradeLinks, icons: multipleUpgradeIcons.length }),
  );

  // --- 7. EIP/ERC mix-up note ------------------------------------------
  await hoverIn('#crosskind');
  const t2 = await waitForTooltip('Referenced as EIP-4337');
  console.log(`      tooltip: ${summarize(t2)}`);
  check('EIP-4337 resolves to canonical ERC-4337', t2.includes('ERC-4337'));
  check('notes the EIP/ERC mix-up', t2.includes('Referenced as EIP-4337'));

  // --- 7b. open-PR proposals -------------------------------------------
  // The payoff for removing the already-linked guard: hovering a Google result
  // title now shows the proposal without leaving the results page.
  if (await hoverIn('#google-result')) {
    const t = await waitForTooltip('Hardfork Meta');
    console.log(`      tooltip: ${summarize(t)}`);
    check('Google result hover shows the proposal', t.includes('Hardfork Meta - Hegotá'));
    await page.screenshot({ path: path.join(HERE, 'google-shot.png') });
  } else {
    check('Google result hover shows the proposal', false, 'no highlight to hover');
  }

  check('open-PR reference is highlighted', (await scoped('#contested')).includes('EIP-8361'));
  check('alias number is highlighted', (await scoped('#aliased')).includes('EIP-8363'));

  if (await hoverIn('#contested')) {
    const t = await waitForTooltip('Transaction Validity Proofs');
    console.log(`      tooltip: ${summarize(t)}`);
    check('contested number shows both claimants', t.includes('Transaction Validity Proofs') && t.includes('Tapered Issuance Burn'));
    check('open and merged claimants have distinct states', (t.match(/UNMERGED/g) ?? []).length === 1);
    check('claimants link to their pull request and specification', t.includes('Pull request') && t.includes('| Spec |'));
    // Hovering the stale 8361 must still lead with 8363 for that claimant, so the
    // reader is corrected rather than confirmed.
    check('renumbered claimant is headed by its canonical number', t.includes('EIP-8363'));
    check('renumbered claimant notes the stale number', t.includes('also EIP-8361'));
    await page.screenshot({ path: path.join(HERE, 'contested-shot.png') });

    // A contested number stacks several full entries, so the card must cap and
    // scroll rather than running off the screen. The shadow root is closed, but
    // the host is an ordinary element, so its box reflects the content height.
    const box = await page.evaluate(() => {
      const host = [...document.body.children].find((c) =>
        (c.getAttribute('style') ?? '').includes('2147483647'),
      );
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { h: r.h ?? r.height, top: r.top, viewport: window.innerHeight, display: host.style.display };
    });
    check('stacked tooltip is visible', box?.display === 'block');
    check(
      'stacked tooltip is capped to the viewport',
      !!box && box.h > 0 && box.h <= box.viewport,
      box ? `${Math.round(box.h)}px in ${box.viewport}px viewport` : 'no host',
    );
  } else {
    check('contested number shows both claimants', false, 'no highlight to hover');
  }

  if (await hoverIn('#aliased')) {
    const t = await waitForTooltip('also EIP-8361');
    console.log(`      tooltip: ${summarize(t)}`);
    check('canonical number resolves to the proposal', t.includes('Tapered Issuance Burn'));
    check('tooltip names the stale number as an alias', t.includes('also EIP-8361'));
    check('tooltip is headed by the canonical number', t.includes('EIP-8363'));
    check('canonical alias is shown as merged with a specification', t.includes('| Spec |') && !t.includes('UNMERGED'));
  } else {
    check('alias resolves to the same proposal', false, 'no highlight to hover');
  }

  if (await hoverIn('#unmerged-single')) {
    const t = await waitForTooltip('UNMERGED');
    console.log(`      tooltip: ${summarize(t)}`);
    check(
      'uncontested open-PR entry is badged and links to its PR',
      t.includes('UNMERGED') && t.includes('Pull request') && !t.includes('| Spec |'),
    );
  } else {
    check('uncontested open-PR entry is badged and links to its PR', false, 'no highlight to hover');
  }


  // --- 7c. selection lookup ---------------------------------------------
  /** Selects the given substring inside `sel`, the way a user would. */
  const selectText = async (sel, needle) => {
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await new Promise((r) => setTimeout(r, 250));
    const ok = await page.evaluate(
      ([s, n]) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const i = n === null ? 0 : (node.nodeValue ?? '').indexOf(n);
          if (i === -1) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, n === null ? (node.nodeValue ?? '').length : i + n.length);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        }
        return false;
      },
      [sel, needle],
    );
    if (ok) await new Promise((r) => setTimeout(r, 400));
    return ok;
  };

  const clearSelection = async () => {
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await new Promise((r) => setTimeout(r, 400));
  };

  // The payoff: 7702 is written bare in #bare and is deliberately NOT
  // highlighted there, because automatic bare matching is off by default.
  // Selecting it must resolve it anyway.
  check('bare number is not auto-highlighted', (await scoped('#bare')).length === 0);
  if (await selectText('#bare', '7702')) {
    const t = await waitForTooltip('Set Code for EOAs');
    console.log(`      tooltip: ${summarize(t)}`);
    check('selecting a bare number looks it up', t.includes('Set Code for EOAs'));
  } else {
    check('selecting a bare number looks it up', false, 'could not select');
  }

  // Selecting prose must do nothing, or reading a page would pop tooltips.
  await clearSelection();
  await selectText('#nodigits', null);
  check('selecting prose shows nothing', !(await tooltipVisible()));

  // A number with no proposal stays silent unless debug mode is on.
  await clearSelection();
  await selectText('#amounts', '7702%');
  check('selecting a non-token shows nothing', !(await tooltipVisible()));

  await clearSelection();
  if (await selectText('#crosskind', 'EIP-4337')) {
    const t = await waitForTooltip('Referenced as EIP-4337');
    check('selecting EIP-4337 resolves canonical ERC-4337', t.includes('ERC-4337') && t.includes('Referenced as EIP-4337'));
  } else {
    check('selecting EIP-4337 resolves canonical ERC-4337', false, 'could not select');
  }

  // Escape must dismiss a selection-shown tooltip.
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));
  check('Escape dismisses a selection lookup', !(await tooltipVisible()));

  // --- 7d. debug mode ---------------------------------------------------
  await clearSelection();
  await setSetting({ debugMode: true });

  if (await selectText('#debug-miss', '9998')) {
    const t = await waitForTooltip('Not in the active database');
    console.log(`      tooltip: ${summarize(t)}`);
    check(
      'debug mode reports an unknown number',
      t.includes('EIP-9998') &&
        t.includes('Not in the active database') &&
        !t.includes('Bundled fallback') &&
        !t.includes('Downloaded and signature-verified') &&
        !t.includes('Check for updates') &&
        !t.includes('2026082401'),
    );
  } else {
    check('debug mode reports an unknown number', false, 'could not select');
  }

  // Even in debug mode, prose must stay silent.
  await clearSelection();
  await selectText('#nodigits', null);
  check('debug mode still ignores prose', !(await tooltipVisible()));

  await setSetting({ debugMode: false });
  await clearSelection();

  // --- 7e. bare numbers, unrestricted -----------------------------------
  // With `predictEthBlocks` off -- the default -- the setting itself is the only
  // gate: every block matches, whatever it is about, down to single digits.
  await setSetting({ bareNumbers: true, predictEthBlocks: false });
  await waitFor(async () => (await scoped('#post-noise')).length > 0, 6000);

  const loose = {
    postNoise: await scoped('#post-noise'),
    postVocab: await scoped('#post-vocab'),
    bare: await scoped('#bare'),
    small: await scoped('#small-bare'),
    years: await scoped('#years'),
    amounts: await scoped('#amounts'),
    slug: await scoped('#slug'),
  };
  check(
    'unrestricted: a block with no Ethereum words matches',
    loose.postNoise.includes('4337') && loose.postNoise.includes('8141'),
    JSON.stringify(loose.postNoise),
  );
  check(
    'unrestricted: a lone bare number matches',
    loose.bare.includes('7702'),
    JSON.stringify(loose.bare),
  );
  check(
    'unrestricted: numbers under 1000 match',
    loose.small.includes('20') && loose.small.includes('7'),
    JSON.stringify(loose.small),
  );
  check(
    'unrestricted: a year that is a real proposal matches',
    loose.years.includes('2025') && loose.years.includes('2026'),
    JSON.stringify(loose.years),
  );
  check(
    'unrestricted: a currency amount matches',
    loose.amounts.includes('7702'),
    JSON.stringify(loose.amounts),
  );
  // The structural checks are the ones that survive: the slug's 7702 is a whole
  // number and matches, while 0x7702 in the same block never can.
  check(
    'unrestricted: a hyphenated slug matches but hex does not',
    loose.slug.length === 1 && loose.slug[0] === '7702',
    JSON.stringify(loose.slug),
  );

  // --- 7e2. predictEthBlocks: the per-block gate, restored --------------
  // The regression this guards: the gate used to ask whether the PAGE held a
  // prefixed reference, so one Ethereum post unlocked every unrelated post
  // beside it, while a post written only in bare numbers never unlocked at all.
  await setSetting({ predictEthBlocks: true });
  await waitFor(async () => (await scoped('#post-noise')).length === 0, 6000);

  const postEth = await scoped('#post-eth');
  const postNoise = await scoped('#post-noise');
  const postVocab = await scoped('#post-vocab');
  check('alpha: a prefixed post unlocks its own bare number', postEth.includes('4337'), JSON.stringify(postEth));
  check(
    'alpha: the post beside it stays locked',
    postNoise.length === 0,
    JSON.stringify(postNoise),
  );
  check(
    'alpha: Ethereum vocabulary unlocks a post with no prefix',
    postVocab.includes('8141') && postVocab.includes('8288'),
    JSON.stringify(postVocab),
  );
  // The terse-block tradeoff, live: no vocabulary, so no unlock even with the
  // setting on. Selecting the number is the way in -- checked in 7c.
  check('alpha: a block with no evidence stays locked', (await scoped('#bare')).length === 0);
  check(
    'alpha: the meaning filters are back',
    (await scoped('#years')).length === 0 && (await scoped('#amounts')).length === 0,
    JSON.stringify([await scoped('#years'), await scoped('#amounts')]),
  );
  check('alpha: the digit floor is back', (await scoped('#small-bare')).length === 0);

  // --- 7e3. the bare-number site blacklist ------------------------------
  // Not `disabledSites`: only the guessing stops, prefixed references stay.
  await setSetting({ predictEthBlocks: false, bareNumberBlockedSites: ['127.0.0.1'] });
  // Waits on something that actually changes: in alpha mode #post-eth held its
  // prefixed reference *and* the bare 4337 beside it, and now keeps only the first.
  await waitFor(async () => (await scoped('#post-eth')).length === 1, 6000);
  check(
    'a blacklisted site matches no bare numbers',
    (await scoped('#post-noise')).length === 0 && (await scoped('#bare')).length === 0,
  );
  check(
    'a blacklisted site still matches prefixed references',
    (await scoped('#prefixed')).includes('EIP-7702'),
    JSON.stringify(await scoped('#prefixed')),
  );

  await setSetting({ bareNumberBlockedSites: [], bareNumbers: false });
  check('turning bare numbers off relocks the post', (await scoped('#post-vocab')).length === 0);

  // --- 8. rescan after client-side render ------------------------------
  await page.evaluate(() => window.addLate());
  // Poll: a rescan is debounced then run in an idle callback, so a fixed wait
  // either flakes or wastes time.
  const late =
    (await waitFor(async () => {
      const found = await scoped('#lateref');
      return found.includes('EIP-1559') ? found : undefined;
    }, 6000)) ?? (await scoped('#lateref'));
  const diag = await page.evaluate(() => ({
    exists: !!document.getElementById('lateref'),
    total: CSS.highlights.get('eip-ref')?.size ?? 0,
  }));
  check(
    'rescans DOM added later (MutationObserver)',
    late.includes('EIP-1559'),
    `${JSON.stringify(late)} exists=${diag.exists} totalRanges=${diag.total}`,
  );

  await page.screenshot({ path: path.join(HERE, 'fixture-shot.png') });
} finally {
  await browser.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
  await rm(`${profile}-legacy`, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
