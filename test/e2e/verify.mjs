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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

// Serve the fixture over http: content scripts do not run on file:// URLs
// unless the extension is granted file access.
const fixture = await readFile(path.join(HERE, 'fixture.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

console.log(`browser: ${BROWSER}\nfixture: ${URL}\n`);

/** Drops the tooltip's inlined <style> text so the log stays readable. */
const summarize = (text) =>
  (text || '(empty)')
    .split(' | ')
    .filter((part) => !part.includes('{'))
    .join(' | ') || '(empty)';

const profile = await mkdtemp(path.join(tmpdir(), 'eip-helper-e2e-'));

const COMMON_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
];

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
      headless: false,
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
      headless: false,
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
  check('tooltip shows links', ['Spec', 'Discussion', 'Source'].every((l) => shadowText.includes(l)));

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
    check('each claimant is badged UNMERGED', (t.match(/UNMERGED/g) ?? []).length >= 2);
    check('claimants link to their pull requests', t.includes('Pull request'));
    check('contested tooltip offers no dead Spec link', !t.includes('| Spec |'));
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

  if (await selectText('#debug-miss', '9999')) {
    const t = await waitForTooltip('Not in the bundled dataset');
    console.log(`      tooltip: ${summarize(t)}`);
    check(
      'debug mode reports an unknown number',
      t.includes('EIP-9999') && t.includes('Not in the bundled dataset'),
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

  // --- 7e. bare numbers unlock per block, not per page ------------------
  // The regression this guards: the gate used to ask whether the PAGE held a
  // prefixed reference, so one Ethereum post unlocked every unrelated post
  // beside it, while a post written only in bare numbers never unlocked at all.
  await setSetting({ bareNumbers: true });
  await waitFor(async () => (await scoped('#post-vocab')).length > 0, 6000);

  const postEth = await scoped('#post-eth');
  const postNoise = await scoped('#post-noise');
  const postVocab = await scoped('#post-vocab');
  check('a prefixed post unlocks its own bare number', postEth.includes('4337'), JSON.stringify(postEth));
  check(
    'the post beside it stays locked',
    postNoise.length === 0,
    JSON.stringify(postNoise),
  );
  check(
    'Ethereum vocabulary unlocks a post with no prefix',
    postVocab.includes('8141') && postVocab.includes('8288'),
    JSON.stringify(postVocab),
  );
  // The terse-block tradeoff, live: no vocabulary, so no unlock even with the
  // setting on. Selecting the number is the way in -- checked in 7c.
  check('a block with no evidence stays locked', (await scoped('#bare')).length === 0);

  await setSetting({ bareNumbers: false });
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
