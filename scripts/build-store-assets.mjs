/**
 * Renders Chrome Web Store promotional images.
 *
 * Run with `npm run store-assets`. Unlike the extension icons, these are not
 * build inputs -- they exist only to upload to the Developer Dashboard -- so
 * nothing in the extension reads the output.
 *
 * Mirrors the mark from `build-icons.mjs`: the badge is the same rounded
 * square with the dotted underline, just inverted (white square, dark text)
 * so it sits on the tile's own dark background instead of being it.
 *
 * Pass --zoom to also write a nearest-neighbour magnification of the finished
 * PNG, for checking the raster. See the note on that flag below -- how you
 * magnify decides whether you can see aliasing at all.
 */
import puppeteer from 'puppeteer-core';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const STORE_DIR = path.join(ROOT, 'store');

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
const BADGE_RULE = '#4f46e5';
const MUTED = '#a4a4b0';
const ARROW = '#6e6e78';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * The design's system-font stack, with 'Segoe UI' in SINGLE quotes.
 *
 * This is load-bearing, and it is the trap that cost three rounds. Every
 * element below is built as an inline `style="..."` attribute, so a family
 * name in double quotes closes the attribute at its first character: the
 * browser then sees no `font-family` at all and falls back to its default,
 * which is a serif. The symptom -- a tile rendered in Times -- looks exactly
 * like "headless Chrome cannot resolve `-apple-system`", and was misread as
 * that, so the stack was swapped for Helvetica Neue to work around a problem
 * that was never about font resolution.
 *
 * The alias keywords resolve fine. Verified with CDP
 * `CSS.getPlatformFontsForNode`, headless and headed alike: this stack lands
 * on `.SF NS`, and so does `system-ui` or `BlinkMacSystemFont` alone. Only a
 * bare `-apple-system` with nothing after it fails, and it is never bare here.
 *
 * Using the real system font also buys the headline's specified weight. SF is
 * variable and draws a true 650. Helvetica Neue is not: 600, 650, 700 and 800
 * all snap to the one Bold face -- measured, all four set the headline to an
 * identical 288.97px -- so the design's 650 silently became 700.
 */
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;

/**
 * The dotted rule, as a repeating hard-edged gradient rather than
 * `border-style: dotted`.
 *
 * Chrome's dotted-border painter fits a whole number of dots into the border's
 * length and absorbs the remainder into the first gap, so the rule opens with
 * a 1px or 3px gap where every other gap is 2px. At this size that irregular
 * first step is the most conspicuously wrong thing on the tile.
 *
 * A 4px-wide gradient tile with a hard stop at 2px repeats on an exact pitch
 * and never accumulates rounding. Both stops land on whole pixels, so the dots
 * stay fully saturated -- measured, still only #9b91ff and the background, no
 * partial-coverage pixels -- which is what you want. A 2px dot is too small to
 * antialias: drawn as an SVG circle it does not get a soft edge, it just comes
 * out uniformly dimmer (155,145,255 -> 136,127,222), i.e. washed out rather
 * than smoother.
 */
function dottedRule(colour) {
  return (
    `background-image:linear-gradient(90deg,${colour} 0 2px,transparent 2px 4px);` +
    `background-size:4px 2px;background-repeat:repeat-x`
  );
}

/** The badge: white rounded square, dark "EIP", dotted underline in the deep indigo -- legible on white, unlike the periwinkle rule used everywhere else on the mark. */
function badge() {
  return `<span style="
      display:inline-flex;flex-direction:column;align-items:center;justify-content:center;
      width:30px;height:30px;border-radius:8px;background:${FG};gap:2px">
    <span style="font:700 9.5px/1 ${MONO};color:${BG}">EIP</span>
    <span style="display:block;width:16px;height:2px;${dottedRule(BADGE_RULE)}"></span>
  </span>`;
}

/** 440x280 small promo tile, mandatory for the Chrome Web Store listing. */
function promoTile() {
  return `<div style="
      width:440px;height:280px;box-sizing:border-box;padding:32px;
      background:${BG};color:${FG};font-family:${SANS};
      display:flex;flex-direction:column;justify-content:space-between;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px">
      ${badge()}
      <span style="font-size:16px;font-weight:600;letter-spacing:-0.01em">EIPeek</span>
    </div>

    <div style="margin-top:22px">
      <div style="font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-0.025em">Every EIP reference,<br>explained on hover.</div>
      <div style="margin-top:12px;font-size:13.5px;line-height:1.45;color:${MUTED};text-wrap:pretty">Hover any EIP or ERC reference for its title, status, and links to the spec, discussion, and source.</div>
    </div>

    <div style="margin-top:22px;display:flex;align-items:baseline;gap:8px;font:13px/1 ${MONO}">
      <span style="color:${FG};padding-bottom:3px;background-position:left bottom;${dottedRule(RULE)}">EIP-7702</span>
      <span style="color:${ARROW}">&rarr;</span>
      <span style="color:${MUTED}">Final &middot; Core &middot; Set Code for EOAs</span>
    </div>
  </div>`;
}

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--no-first-run', '--hide-scrollbars'],
});

/**
 * Screenshots `html` at exactly width x height, opaque -- store images may not
 * carry transparency.
 *
 * Captured directly at deviceScaleFactor 1. Rendering oversized and shrinking
 * back down has now been tried twice and measured properly once: it buys
 * nothing here. Downsampling a 3x or 4x capture with an exact box filter
 * leaves the dotted rules byte-for-byte identical to the 1x capture, because
 * Chrome scales the dot geometry with the device pixel ratio and keeps it
 * aligned to the grid, so every box cell is uniform. All it changes is the
 * text, which it softens: 1x lets Chrome hint each glyph onto the pixel grid,
 * and that is the crispest this raster gets.
 */
async function shoot(html, width, height, out) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<body style="margin:0;width:${width}px;height:${height}px;overflow:hidden">${html}`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: false, type: 'png' });
  await page.close();
  console.log(`  ${path.relative(ROOT, out)}  ${width}x${height}`);
}

/**
 * Reads the PNG header and fails the build if the store's two hard rules are
 * broken: exact pixel size, and no alpha channel.
 */
async function assertPng(file, width, height) {
  const buf = await readFile(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const colourType = buf[25];
  const problems = [];
  if (w !== width || h !== height) problems.push(`is ${w}x${h}, must be ${width}x${height}`);
  // 4 = greyscale+alpha, 6 = RGBA. Either would be rejected at upload.
  if (colourType === 4 || colourType === 6) problems.push('carries an alpha channel');
  if (problems.length) {
    console.error(`  ${path.relative(ROOT, file)}: ${problems.join('; ')}`);
    process.exitCode = 1;
  }
}

try {
  await mkdir(STORE_DIR, { recursive: true });
  const tile = path.join(STORE_DIR, 'promo-440x280.png');
  await shoot(promoTile(), 440, 280, tile);
  await assertPng(tile, 440, 280);

  if (process.argv.includes('--zoom')) {
    // The sheet shows the PNG that was just written, not a re-render of the
    // HTML at a larger size: laying the tile out again at 6x would draw new,
    // finer text and hide the very pixels being inspected. `pixelated` is the
    // other half of that -- it replicates each shipped pixel as a hard block.
    // A smooth zoom (`sips -z`, or any default `<img>` upscale) interpolates,
    // which launders real jaggedness into a convincing blur and makes a broken
    // raster look fine. That mistake is why this took three rounds.
    const src = `data:image/png;base64,${(await readFile(tile)).toString('base64')}`;
    const at = (x, label) => `
      <div style="margin-bottom:20px">
        <div style="font:12px ${MONO};color:#8b8b96;margin-bottom:8px">${label}</div>
        <img src="${src}" width="${440 * x}" height="${280 * x}"
             style="image-rendering:pixelated;display:block">
      </div>`;
    // A tight crop of the badge and the example line, where the fine detail is.
    const crop = (x, y, w, h, f, label) => `
      <div style="margin-bottom:20px">
        <div style="font:12px ${MONO};color:#8b8b96;margin-bottom:8px">${label}</div>
        <div style="width:${w * f}px;height:${h * f}px;overflow:hidden;position:relative">
          <img src="${src}" width="${440 * f}" height="${280 * f}"
               style="image-rendering:pixelated;position:absolute;
                      left:${-x * f}px;top:${-y * f}px">
        </div>
      </div>`;
    const sheet =
      `<div style="display:inline-block;background:#0b0b0e;padding:24px">` +
      at(1, '1x -- the shipped pixels') +
      crop(30, 30, 84, 34, 10, 'badge + wordmark @10x') +
      crop(32, 226, 130, 22, 10, 'example line + dotted rule @10x') +
      at(2, '2x') +
      `</div>`;
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">${sheet}`);
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(tmpdir(), 'eipeek-promo-zoom.png');
    await (await page.$('body > div')).screenshot({ path: out, type: 'png' });
    await page.close();
    console.log(`  ${out}`);
  }
} finally {
  await browser.close();
}
