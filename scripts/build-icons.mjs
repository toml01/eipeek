/**
 * Renders the extension icons.
 *
 * Run with `npm run icons`. The PNGs are committed -- the manifest points at
 * them, so they are inputs to the build, not products of it. This only needs
 * running when the mark changes.
 *
 * The mark is the letters in monospace bold over a dotted periwinkle
 * underline: the same decoration the CSS Custom Highlight API paints on a
 * matched reference, so the icon shows what the extension does. Below 48px
 * three letters stop resolving, so 16 and 32 carry a single letter and keep
 * the underline -- the one part of the mark that survives at toolbar size.
 *
 * Pass --sheet to also write a contact sheet of all four at 1x over light and
 * dark, for eyeballing legibility. That one is not committed.
 */
import puppeteer from 'puppeteer-core';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const ICON_DIR = path.join(ROOT, 'src', 'public', 'icon');
const SHEET = path.join(ROOT, 'icon-contact-sheet.png');

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

const BG = '#17171b';
const FG = '#fff';
const RULE = '#9b91ff';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * One entry per icon Chrome asks for.
 *
 * `art` is the drawn square. Only the 128 is smaller than its canvas: the
 * Chrome Web Store wants 96px of artwork inside a 128px frame, and the 16px
 * border has to be real transparency, not a background colour. Toolbar sizes
 * are full bleed -- padding there just shrinks an already tiny mark.
 *
 * `lift` raises the whole lockup off the geometric centre. `line-height: 1`
 * makes the text box exactly one em tall, but the descent space under a
 * capital is dead weight, so flex centring lands the ink low: measured, 3px
 * low at 128, 2px at 48, 1.375px at 32. A 1px lift is the closest correction
 * the pixel grid allows -- Chrome snaps both the baseline and the border to
 * whole CSS pixels, so fractional values do nothing. The 16 is already
 * balanced to within an eighth of a pixel, and 1px there would be 6% of the
 * icon, so it stays put.
 */
const SPECS = [
  { size: 128, art: 96, radius: 22, gap: 8, text: 'EIP', font: 30, track: 0.01, rule: 54, weight: 4, lift: 1 },
  { size: 48, art: 48, radius: 11, gap: 4, text: 'EIP', font: 15, track: 0, rule: 27, weight: 2, lift: 1 },
  { size: 32, art: 32, radius: 7, gap: 3, text: 'E', font: 13, track: 0, rule: 16, weight: 2, lift: 1 },
  { size: 16, art: 16, radius: 4, gap: 1, text: 'E', font: 8, track: 0, rule: 9, weight: 1.5, lift: 0 },
];

/**
 * The mark as HTML, sized for one spec.
 *
 * The lockup is its own box inside the art square so that lifting it cannot
 * disturb the text-to-underline gap, which is design-specified.
 */
function mark(s) {
  const track = s.track ? `letter-spacing:${s.track}em;` : '';
  return `<div style="
      width:${s.size}px;height:${s.size}px;
      display:flex;align-items:center;justify-content:center">
    <div style="
        width:${s.art}px;height:${s.art}px;box-sizing:border-box;
        border-radius:${s.radius}px;background:${BG};
        display:flex;align-items:center;justify-content:center">
      <div style="
          display:flex;flex-direction:column;align-items:center;gap:${s.gap}px;
          position:relative;top:${-s.lift}px">
        <div style="font:700 ${s.font}px/1 ${MONO};${track}color:${FG}">${s.text}</div>
        <div style="width:${s.rule}px;border-top:${s.weight}px dotted ${RULE}"></div>
      </div>
    </div>
  </div>`;
}

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--no-first-run', '--force-device-scale-factor=1', '--hide-scrollbars'],
});

/** Screenshots `html` at exactly width x height. Transparent where unpainted. */
async function shoot(html, width, height, out, omitBackground = true) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<body style="margin:0;width:${width}px;height:${height}px;overflow:hidden">${html}`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground, type: 'png' });
  await page.close();
  console.log(`  ${path.relative(ROOT, out)}  ${width}x${height}`);
}

try {
  await mkdir(ICON_DIR, { recursive: true });
  for (const s of SPECS) {
    await shoot(mark(s), s.size, s.size, path.join(ICON_DIR, `${s.size}.png`));
  }

  if (process.argv.includes('--sheet')) {
    // The sheet shows the PNGs that were just written, not a re-render of the
    // HTML: magnifying with `zoom` would lay the text out again at 4x and hide
    // exactly the pixel-grid damage the sheet exists to catch. `pixelated`
    // keeps the shipped pixels visible.
    const src = Object.fromEntries(
      await Promise.all(
        SPECS.map(async (s) => [
          s.size,
          `data:image/png;base64,${(await readFile(path.join(ICON_DIR, `${s.size}.png`))).toString('base64')}`,
        ]),
      ),
    );
    const img = (s, x) =>
      `<img src="${src[s.size]}" width="${s.size * x}" height="${s.size * x}"
            style="image-rendering:pixelated;display:block">`;
    // Chrome's own toolbar greys, so "does it read in the toolbar" is testable.
    const panel = (bg, fg, label) => `
      <div style="background:${bg};color:${fg};padding:22px 26px;font:12px ${MONO}">
        <div style="opacity:.65;margin-bottom:16px">${label}</div>
        ${[1, 4]
          .map(
            (x) => `<div style="display:flex;align-items:flex-end;gap:26px;margin-bottom:18px">
              ${SPECS.map(
                (s) => `<div style="text-align:center">
                  ${img(s, x)}
                  <div style="margin-top:8px;opacity:.65">${s.size}${x > 1 ? ` @${x}x` : ''}</div>
                </div>`,
              ).join('')}
            </div>`,
          )
          .join('')}
      </div>`;
    const sheet =
      `<div style="display:inline-block">` +
      panel('#f1f3f4', '#17171b', 'light toolbar #f1f3f4') +
      panel('#35363a', '#e8eaed', 'dark toolbar #35363a') +
      `</div>`;
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">${sheet}`);
    await page.evaluate(() => document.fonts.ready);
    await (await page.$('body > div')).screenshot({ path: SHEET, type: 'png' });
    await page.close();
    console.log(`  ${path.relative(ROOT, SHEET)}`);
  }
} finally {
  await browser.close();
}
