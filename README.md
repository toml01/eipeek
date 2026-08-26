# EIPeek

[![CI](https://github.com/toml01/eipeek/actions/workflows/ci.yml/badge.svg)](https://github.com/toml01/eipeek/actions/workflows/ci.yml)

A Chrome extension that annotates EIP/ERC references on any page. It highlights
references like `EIP-7702` and, on hover, shows the full title, status, and links
to the spec, forum discussion, and source.

> EIP-7702 → **EIP-7702** · Final · Core — Set Code for EOAs

Covers **1195 merged proposals plus 218 that so far exist only in an open pull
request**, across `ethereum/EIPs` and `ethereum/ERCs`, bundled with the extension.
**No network requests are made while you browse** — the dataset is in the
package, so the pages you read stay on your machine. An on-by-default daily
background check contacts GitHub; you can disable it in settings. A manual
**Check for updates** remains available. See [PRIVACY.md](PRIVACY.md).

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/jeehadjadegokhcgmnnkdcenbpbolkll).

To build from source:

```sh
npm install
npm run build
```

Then load `.output/chrome-mv3` via `chrome://extensions` → Developer mode →
**Load unpacked**.

Click the toolbar icon for settings.

## Features

- Prefixed matching: `EIP-7702`, `ERC-20`, and list forms such as `EIPs 3074 and 7702`.
- Optional bare-number matching (`7702`) is off by default, so years and quantities do not light up.
- Includes unmerged proposals that so far exist only in an open pull request.
- Renumbered proposals still resolve: hover the old number and you get the current one.
- Select a number to look it up on demand, prefix or not.
- Per-site blocking for the whole extension or for bare numbers only.
- The tooltip shows mainnet upgrade membership.
- Every tooltip has a **Mistake?** link that opens a prefilled GitHub feedback form.

## Permissions

The manifest permissions are exactly `storage` and `alarms`. `storage` holds
settings, verified downloaded database bytes, and small activation/status
signals. `alarms` schedules the on-by-default approximate daily background
database check. There is no `tabs` permission. The content script matches
`<all_urls>` because an EIP number can appear on any page; that is what makes
the install prompt say "Read and change your data on all websites". The
extension reads text nodes and paints highlights. See [PRIVACY.md](PRIVACY.md).

## Known limitations

- **Open-PR entries can go stale.** A proposal whose PR is closed, merged, or
  renumbered stays in the bundled dataset until the next `npm run data:build` and
  release. Turn the tier off in options if you want merged-only.
- **No keyboard access to the tooltip.** Highlights are not DOM nodes and cannot
  take focus. Hover is pointer-only; selecting a reference is the keyboard-reachable
  path.
- **New content is decorated after a ~300 ms debounce**, so during fast
  continuous scrolling there is a brief window where fresh references are not yet
  underlined.
- **A very long non-virtualized feed can hit the 2000-match cap.**
- **A reference split across a block boundary is not matched**, by design. See
  [References split across elements](docs/architecture.md#references-split-across-elements).
- **Chromium only.** `CSS.highlights` is needed for painting. A Firefox port is
  plausible since hover no longer depends on a Chrome-only API.
- **Automatic check timing is approximate.** Chrome may delay alarms while the
  browser or device is asleep, and there is no retry loop. Browsing itself still
  triggers no network requests.

## Development

```sh
npm run dev         # dev build with HMR
npm run build       # production build
npm test            # unit tests (matcher + dataset integrity)
npm run test:e2e    # drives a real browser; run `npm run build` first
npm run compile     # type-check
```

See [AGENTS.md](AGENTS.md) for the full contributor reference and
[docs/architecture.md](docs/architecture.md) for design rationale.

## Feedback

Have feedback? [Open a GitHub issue](https://github.com/toml01/eipeek/issues/new?template=feedback.yml)
for bugs, database corrections, feature requests, or general comments.

## License

MIT
