import { defineConfig } from 'wxt';

// Rendered by `npm run icons`. Chrome uses `icons` for the extensions page and
// the store and `action.default_icon` for the toolbar button, falling back to
// `icons` when default_icon is absent; the toolbar is where the mark is always
// on screen, so it gets said out loud rather than inherited. Same four files
// either way.
const ICONS = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  128: 'icon/128.png',
};

export default defineConfig({
  srcDir: 'src',
  // Extension pages live in separate execution worlds. Vite's module-preload
  // hints for shared chunks cross those worlds in Chromium, which makes the
  // browser reject the preload and log a misleading warning. The imports still
  // load normally for each page; only the speculative preload is removed.
  vite: () => ({
    // WXT's storage helper contains a multiline diagnostic in a template
    // literal. Lowering template literals makes esbuild escape those newlines,
    // preserving the one-line production worker/dataset invariant.
    esbuild: {
      supported: { 'template-literal': false },
    },
    build: {
      modulePreload: false,
      // The committed dataset stays pretty for review. Its JSON import is
      // embedded in background.js, and production/package output alone gets
      // compacted so source formatting costs no extension bytes.
      minify: 'esbuild',
    },
  }),
  // publicDir defaults to <root>/public even when srcDir moves, so say it:
  // everything shipped lives under src/. Contents are copied to the bundle
  // root, which is what makes the icons resolve as `icon/16.png`.
  publicDir: 'src/public',
  manifest: {
    name: 'EIPeek',
    // storage.session and StorageArea.setAccessLevel were introduced in Chrome
    // 102. Some older implementations reject access-level changes; runtime then
    // keeps the bundled database but disables persistent database actions.
    minimum_chrome_version: '102',
    description:
      'Highlights EIP/ERC references on any page. Hover for the full title, status, and links to the spec, discussion, and source.',
    permissions: ['storage', 'alarms'],
    icons: ICONS,
    // Clicking the toolbar icon shows the settings inline. WXT derives
    // default_popup from the popup entrypoint on its own; this is here so the
    // action -- and its hover title -- is declared where the rest of the
    // manifest is. options_ui stays generated from the options entrypoint, so
    // chrome://extensions still reaches the same form.
    action: {
      default_popup: 'popup.html',
      default_title: 'EIPeek — settings',
      default_icon: ICONS,
    },
  },
});
