import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'EIPeek',
    description:
      'Highlights EIP/ERC references on any page. Hover for the full title, status, and links to the spec, discussion, and source.',
    // storage is the ONLY permission. No host permissions, no tabs, no
    // web_accessible_resources -- the dataset ships bundled, so the extension
    // has no way to observe browsing and nothing for a page to fingerprint.
    permissions: ['storage'],
    // Clicking the toolbar icon shows the settings inline. WXT derives
    // default_popup from the popup entrypoint on its own; this is here so the
    // action -- and its hover title -- is declared where the rest of the
    // manifest is. options_ui stays generated from the options entrypoint, so
    // chrome://extensions still reaches the same form.
    action: {
      default_popup: 'popup.html',
      default_title: 'EIPeek — settings',
    },
  },
});
