# EIPeek

Chrome MV3 extension (WXT). Highlights EIP/ERC references with the CSS Custom Highlight API; metadata is bundled so browsing makes no network requests.

## Commands

- `npm test` — unit tests (Vitest). One file: `npx vitest run test/match.test.ts`
- `npm run compile` — `tsc --noEmit`. Needs `.wxt/` from `postinstall` (`wxt prepare`)
- `npm run build` then `npm run test:e2e` — e2e needs the unpacked build at `.output/chrome-mv3` plus a Chromium binary (`CHROME_PATH` to override). Not jsdom.
- No lint/format script. CI is `compile` → `test` → `build` → `test:e2e` (Node 22, npm).
- `npm run data:build` — regenerate dataset. Needs `GITHUB_TOKEN` or `gh auth login` (GraphQL for open-PR file lists only).
- `npm run data:review` — advisory forum check; **always exits 0**. Read the text. `-- --no-cache` forces a full recheck. Cache: `.cache/review-forum.json` (24h).
- Dataset refresh workflow: `.agents/skills/maintain-eip-data`. Do not invent a parallel collector.

## Layout

- `src/entrypoints/` — `content.ts`, `background.ts`, `popup/`, `options/`
- `src/core/` — matcher, settings, types, links; `numbers.generated.ts` is the inlined number index
- `src/ui/settings-form.ts` — single settings form; popup and options are shells
- `src/ui/tooltip.ts` — closed shadow root + `all: initial`
- `data/eips.json` — generated, committed, pretty JSON. WXT embeds a minified copy in production `background.js`
- `data/aliases.json` — curated only. Never shipped; reasons must not appear in the bundle
- `src/core/numbers.generated.ts` — generated. Edit `data/aliases.json`, then `data:build`
- `src/public/` — shipped static files. `wxt.config.ts` **must** keep `publicDir: 'src/public'` (WXT otherwise looks at `<root>/public`)

## Do not

- Wrap matches in DOM nodes. Paint with `CSS.highlights` only. e2e asserts `document.body.innerHTML` is byte-identical.
- Use `CSS.highlights.highlightsFromPoint` (present-but-empty on some Chromium). Caret hit-test stays.
- Skip already-linked text. No host allowlist for bare numbers. No `getComputedStyle` in the scan (static tag list).
- Add `web_accessible_resources`, `tabs`, or browse-time fetches. Metadata goes through `runtime.sendMessage`.
- Return a Promise from the background `onMessage` listener. Chrome ignores it; use `sendResponse` and `return true`.
- Set `include` or `types` in root `tsconfig.json` (drops WXT’s generated types).
- Re-enable Vite `modulePreload` (cross-world extension preload warnings). Do not put `<title>` in `popup/index.html` (WXT would overwrite `action.default_title`).
- Infer aliases from titles, CI, draft state, or PR order. Infer upgrade membership from ERCs, aliases, or `requires`.
- Add CI, schedules, or API-key requirements to the data tooling.

## Dataset / aliases

- Open-PR alias target: `{ "pr", "repo" }`. After merge: `{ "n": <canonical> }`.
- `reason`: one factual line, ≤160 chars, no `likely`/`probably`/`maybe`/…. Build fails otherwise.
- Open-PR aliases expire 180 days after `prOpened`. Contested numbers stay visible; do not suppress rivals.
- New scheduled fork names fail `data:build` until `UPGRADE_NAMES` and `SCHEDULED_UPGRADES` in `scripts/build-dataset.ts` are updated from upstream evidence.
- Keep `data/*.json` as `JSON.stringify(value, null, 2)` plus a trailing newline.
- `npm run data:maintain` launches a local Codex agent. Do not run it from another agent session.

## Tests / quirks

- Vitest excludes `.claude/**` and `.output/**` (worktree copies would inflate the count).
- e2e also asserts: no `modulepreload` in popup/options HTML, compact one-line `background.js`, `aliases.json` absent from `.output`.
- Icons in `src/public/icon/` are committed inputs; `npm run icons` only when the mark changes.
