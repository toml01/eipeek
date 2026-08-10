# EIPeek

[![CI](https://github.com/toml01/eip-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/toml01/eip-helper/actions/workflows/ci.yml)

A Chrome extension that annotates EIP/ERC references on any page. It highlights
references like `EIP-7702` and, on hover, shows the full title, status, and links
to the spec, forum discussion, and source.

> EIP-7702 → **EIP-7702** · Final · Core — Set Code for EOAs

Covers **1189 merged proposals plus 205 that so far exist only in an open pull
request**, across `ethereum/EIPs` and `ethereum/ERCs`, bundled with the extension.
**No network requests are made while you browse**, and the extension requests no
host permissions.

## Install (development)

```sh
npm install
npm run build
```

Then load `.output/chrome-mv3` via `chrome://extensions` → Developer mode →
**Load unpacked**.

Click the toolbar icon for the settings. The popup and the options page render the
same form from `src/ui/settings-form.ts`, so there is one copy of it.

## How it works

### Highlighting without touching the page

References are painted with the [CSS Custom Highlight API][highlight], not by
wrapping matches in `<span>` elements:

```js
CSS.highlights.set('eip-ref', new Highlight(...ranges));
```

```css
::highlight(eip-ref) { text-decoration: underline dotted; }
```

Span wrapping is the conventional approach and the usual reason extensions break
web apps — it corrupts React/Vue reconciliation, breaks `contenteditable`,
invalidates the page's own `querySelector` logic, and risks MutationObserver
feedback loops. Painting mutates nothing. The e2e suite asserts that
`document.body.innerHTML` is **byte-identical** before and after the content
script runs.

Two constraints follow, both accepted deliberately:

- `::highlight()` accepts only a small property set (`color`,
  `background-color`, `text-decoration`, `text-shadow`, `-webkit-text-stroke`) —
  no `cursor`, no borders, nothing affecting layout. The affordance is therefore
  a dotted underline and an optional tint.
- Highlights are not DOM nodes, so they cannot be focused or receive events.
  See [Known limitations](#known-limitations).

### Hover hit-testing

Hover resolves the caret position under the pointer and confirms it against the
range's own painted rects, using `document.caretPositionFromPoint` (falling back
to `caretRangeFromPoint`).

It deliberately does **not** use `CSS.highlights.highlightsFromPoint`, which is
the purpose-built API for this. That API is Chrome 135+ only, and during
development it was observed **present but always returning an empty array** in a
current Chromium build (Brave 151) — including for a highlight created in the
same world in the same frame. Depending on it would silently disable hover
entirely on affected browsers. The caret approach relies only on long-standing
APIs and behaves identically everywhere.

### Matching

Two tiers, because the number space overlaps ordinary prose badly.

**Tier 1 — prefixed, always on.** `EIP-7702`, `EIP 7702`, `EIP7702`, `EIP_7702`,
`EIP:7702`, en/em-dash variants, and `ERC-20`. Also handles two forms a naive
prefix regex misses:

- the **plural prefix** — `EIPs 3074`, `ERCs`, and `ERC-721s`
- **list continuations** — `EIPs 3074 and 7702`, `EIP-2718, 2930, 4844`.
  Continuations require ≥3 digits, so `EIP-20 and 5 others` does not sweep up
  the quantity.

**Tier 2 — bare numbers, opt-in and off by default.** Matching a bare `7702` is
genuinely dangerous, and the number distribution shows why:

| Hazard | Count | Examples |
| --- | --- | --- |
| Plausible years | 34 | 2015, 2019, 2020, 2021, 2025, 2026 |
| Under 100 | 12 | 1, 2, 3, 20, 55, 67, 86 |
| Three-digit | 79 | 100, 150, 155, 200, 777, 999 |

A page saying "back in 2020" or "150 users" will light up. When you switch Tier 2
on you accept that, and the only remaining rules are the ones that decide *which*
number the text holds:

- it resolves to a real proposal
- it is not a fragment of a longer numeric literal — `1,7702` holds 17702 and
  `7702.5` holds 7702.5, so marking `7702` in either would highlight a number
  nobody wrote
- word boundaries still apply, so `0x7702` and `77021` are untouched

Everything else is opt-in. Two settings narrow it:

| Setting | Effect |
| --- | --- |
| **Blocked sites** | Bare numbers are never marked on these hosts. Prefixed references still are, which is what makes this different from *Disabled sites*. |
| **Predict Ethereum blocks** (alpha) | Restores the conservative rules — see below. |

### References split across elements

Sites that bold a search term split the reference apart. X search renders
`EIP-7702` as three separate text nodes:

```html
<span class="…r-b88u0q">EIP</span><span>-</span><span class="…r-b88u0q">7702</span>
```

Matching each text node alone can never see that. So consecutive **inline** text
runs are concatenated into one string, matched, and every hit is mapped back to
the node and offset it started and ended at — a `Range` may legitimately span
nodes, but it still needs real nodes and offsets, so a flattened string alone is
not enough. `src/core/segments.ts` holds the mapping and is generic over the node
type, which makes it unit-testable without a DOM.

The safety property is that runs are **broken at every block boundary**. Without
that, a paragraph ending in "EIP" followed by text starting with "7702" would be
read as a reference. Runs are grouped by *nearest block-level ancestor*, which is
symmetric — it notices leaving a block as well as entering one. (Flushing only on
entry misses `<p>...EIP</p>7702...`, where no block sits between the two runs.
Whitespace between the tags usually hides that, since the separator pattern
excludes newlines.) Block detection uses a static tag list rather than
`getComputedStyle`, because resolving styles for every element on every rescan
is far too expensive.

There is deliberately **no "already a link, skip it" rule**. One existed to avoid
double-decorating on eips.ethereum.org, but its only real effect was suppressing
highlights on Google, Bing and GitHub — where a result title links to the spec but
shows the reader nothing but a number, making the hover most valuable of all.

One consequence: the per-node "skip text without digits" shortcut had to go, as
the run holding `EIP` contains no digits at all. Measured cost is a few
milliseconds — see [Performance](#performance).

### Unmerged proposals, and numbers as aliases

EIP numbers are assigned while a proposal is still an open pull request, and that
is when most discussion happens — so the newest, most-referenced proposals are
exactly the ones a merged-only dataset cannot see. The build indexes open PRs in
both repos as a second tier, marked `UNMERGED` in the tooltip and linking to the
pull request instead of a spec page (an unmerged number 404s on
eips.ethereum.org).

Two things make this harder than it sounds.

**A number can be claimed by more than one PR, and a claim can be invalid.**
EIP-8361 is claimed by two unrelated proposals. An editor ruled on
[#12081](https://github.com/ethereum/EIPs/pull/12081):

> EIP numbers cannot be self-assigned […] EIP-8361 has already been allocated to
> another proposal (PR #12075).

None of the obvious signals identify the invalid claim: CI passes on both, and
#12075 (the legitimate one) is a GitHub *draft* while #12081 is not, so filtering
drafts would keep the wrong one. Only PR creation order agrees with the editor, so
that decides **display order** — never suppression. The tooltip shows every
claimant in full and lets the reader judge.

**A renumbered proposal keeps being discussed under its old number.** Tapered
Issuance Burn self-assigned 8361; its real number is **8363** — the Hegotá list
cites it that way, and its Magicians thread redirects to
`eip-8363-tapered-issuance-burn`. But X threads still say 8361. Since the point of
the extension is to resolve *what people write* without endorsing it, a proposal
is filed under the number an editor assigned and still answers to the stale ones,
via `data/aliases.json`:

```json
[{ "canonical": 8363, "alsoKnownAs": [8361], "target": { "pr": 12081, "repo": "EIPs" }, "reason": "…" }]
```

Hovering 8361 therefore shows a card headed **EIP-8363** with *also EIP-8361* — the
reference resolves, and the reader is corrected rather than confirmed. Note the PR
file is still named `eip-8361.md`, so the source link uses the filename while the
display uses the canonical number; linking `eip-8363.md` would 404.

That file is **hand-maintained on purpose**. Renumberings are rare, and automated
title-matching would risk silently merging unrelated proposals. Targets are keyed
by PR number because "the proposal at 8361" is ambiguous while "the proposal from
PR #12081" is not. Every entry needs a `reason`, and the build fails if a target
has gone missing or if two proposals claim the same canonical number. An alias
*overlapping* another proposal's number is fine — that is the contested case, and
both get shown.

### Predict Ethereum blocks (alpha)

This option judges **each text block on its own** and only allows bare numbers in
blocks that look Ethereum-related. A block qualifies if it holds a prefixed
reference, or at least **two distinct** Ethereum terms. Two, because one is
reachable by coincidence — "fork" in a recipe, "account" in a bank statement.
Measured distinct-term counts:

| Block | Terms | Bare numbers |
| --- | --- | --- |
| "native rollups via STARK-carrying frame transactions (8141 + 8288)" | 4 | matched |
| "gas limit bump to 8141 in the next fork" | 2 | matched |
| "the RTX 4090 beats the 3080 and costs 1599 dollars" | 0 | ignored |
| "returns 8141 records per page with a 4096 byte limit" | 0 | ignored |
| "bind to 8141 and forward 8288 through the proxy" | 0 | ignored |

Per block, not per page: a page-wide test is wrong in both directions on a feed —
one post mentioning EIP-7702 would unlock every unrelated post beside it, and a
post writing only bare numbers would never unlock at all.

The option also restores the 4-digit minimum and the year, currency, unit, date
and hyphenated-identifier filters. Terse blocks lose out either way: "thoughts on
8141?" scores 0 and stays locked, which is what the selection lookup below is for.

There is deliberately **no host allowlist**. Site-level trust is expressed by the
blocked-sites list instead, which subtracts rather than adds.

### Looking up a number you select

Automatic bare-number matching stays conservative, so a number in a block with no
Ethereum signal at all is still unreachable — "thoughts on 8141?" carries nothing
to judge it by, and bare matching is off by default regardless.

Selecting the number fixes that. A selection that is *only* a reference —
`8141`, `EIP-8141`, `#8141` — looks it up and skips every gate: no digit floor, no
year or currency rejection, no page context. Selecting a number is stronger
evidence that it is a reference than any heuristic, so `20` and `2025` resolve here
even though automatic matching will never claim them.

The parser is anchored at both ends, and that anchoring is the safety property:
selecting a sentence cannot trigger anything. Misses are silent unless **debug
mode** is on, which reports whether the number is absent from the dataset or
merely in a tier you have switched off.

### Shared number namespace

EIPs and ERCs share one number space, so a number identifies exactly one
proposal. Writing `EIP-4337` for what is canonically ERC-4337 therefore refers to
the right thing by the wrong name — the tooltip shows the canonical label and
notes *"Referenced as EIP-4337"* rather than treating it as a miss.

### Payload split

Pages with no references should cost nothing, so the data is split in two:

| | Size | Where |
| --- | --- | --- |
| Number index | ~7 KB | inlined in the content script, for instant rejection |
| Full metadata | 334 KB | background worker, fetched only after a match |

The content script injected into every page is **~20 KB**. Metadata travels over
`runtime.sendMessage` rather than `web_accessible_resources`, so there is no
fetchable extension URL for a page to probe for.

## The dataset

`data/eips.json` is generated and committed; `data/aliases.json` is hand-written.
Regenerate with:

```sh
npm run data:build   # needs GITHUB_TOKEN, or `gh auth login`
```

The token is only for enumerating open pull requests: listing 756 PRs *with their
file lists* needs GraphQL, and GraphQL always requires auth. Everything else in
the build is unauthenticated.

The **GitHub repos are the source of truth**, not `eips.ethereum.org`:

- The site is a Jekyll build *of* those repos, so it is downstream by
  construction and cannot be fresher.
- Its `/all` index carries only number, title, and author — `discussions-to` and
  per-proposal `description` appear **zero** times, and the tooltip needs both.
- Its Atom feed is empty boilerplate: `jekyll-feed` renders `site.posts`, but
  proposals are Jekyll *pages*, so the feed contains no `<entry>` elements at
  all.

Frontmatter is parsed with `js-yaml` rather than by splitting lines, because 16
titles are YAML-quoted to escape an embedded colon
(`title: "Hardfork Meta: Homestead"`) and a line parser ships the quotes into
the UI.

Deduplication: 365 of the 366 cross-repo overlaps are `status: Moved` stubs left
behind by the ERC split; the only real collision is EIP-1, resolved by preferring
the EIPs copy.

**The build validates itself against the published site** and fails on any
disagreement — number sets must match exactly in both directions, every title
must match, and no title may retain quote characters. That check covers the
**merged tier only**, since open-PR proposals appear nowhere on the site; they get
schema checks instead, plus a count bound so a GraphQL change fails loudly rather
than silently shipping zero. Open-PR frontmatter is unreviewed, so the build also
drops files whose filename and `eip:` field disagree, and normalises unknown
statuses (one PR declares `status: New`). Site cells are selected by
semantic class (`.eipnum`, `.title`) rather than column position, since the
column layout varies per status section (Last Call inserts *Review ends*,
Withdrawn inserts *Withdrawn Reason*).

## Development

```sh
npm run dev         # dev build with HMR
npm run build       # production build
npm test            # unit tests (matcher + dataset integrity)
npm run test:e2e    # drives a real browser; run `npm run build` first
npm run compile     # type-check
npm run data:build  # regenerate the dataset
```

`npm run test:e2e` exists because the load-bearing behaviour cannot be tested in
jsdom: the highlight API, caret hit-testing, and the no-DOM-mutation guarantee.
It auto-detects a Chromium-based browser; set `CHROME_PATH` to override.

It loads the unpacked build over CDP (`Extensions.loadUnpacked`, via
`browser.installExtension`), falling back to `--load-extension`. Both paths are
needed: Chrome 137 removed `--load-extension` from *branded* Chrome builds
because malware abused it, while Chromium, Chrome for Testing, and forks such as
Brave still support it. The CDP path additionally requires pipe transport and
`--enable-unsafe-extension-debugging`.

CI runs the same suite on the runner's Google Chrome under `xvfb`, and uploads
both the hover screenshot and the packaged zip.

## Permissions

`storage` only — for settings. No host permissions, no `tabs`, no
`web_accessible_resources`. The extension has no way to observe browsing.

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
- **A very long non-virtualized feed can hit the 2000-match cap.** At the density
  measured below that is roughly 6000 posts. Feeds that drop offscreen nodes
  (Twitter, most modern timelines) stay well under it.
- **A reference split across a block boundary is not matched**, by design — see
  [above](#references-split-across-elements).
- **No icons yet**, so the extension shows a default placeholder in the toolbar
  and cannot be submitted to the Chrome Web Store as-is.
- **Chromium only.** `CSS.highlights` is needed for painting. A Firefox port is
  plausible since hover no longer depends on a Chrome-only API.
- **Data goes stale between releases**, by design — the dataset is bundled so
  that browsing triggers no network requests.

## Performance

### Scan cost on real pages

Median of 9 runs over saved pages replayed through the real scan pipeline. Times
are the whole scan; the count is matches found.

| Page | Text nodes | Tier 2 off | Unrestricted | Alpha |
| --- | --- | --- | --- | --- |
| eips.ethereum.org `/all` | 15664 | 19.2 ms / 107 | 19.0 ms / **1341** | 18.8 ms / 107 |
| Wikipedia Olympic medals | 16218 | 30.5 ms / 0 | 31.0 ms / **2262** | 30.4 ms / 0 |
| Wikipedia by population | 8273 | 14.9 ms / 0 | 15.1 ms / **911** | 14.9 ms / 0 |
| Wikipedia "Ethereum" | 4766 | 7.8 ms / 23 | 7.8 ms / **475** | 7.7 ms / 24 |
| eip-7702 spec page | 977 | 1.2 ms / 37 | 1.2 ms / **70** | 1.2 ms / 39 |
| Hacker News front page | 481 | 1.0 ms / 0 | 1.0 ms / **39** | 1.0 ms / 0 |

Unrestricted Tier 2 costs almost nothing in time — matching alone goes from
0.3 ms to 1.1 ms at worst, and total scan time rises by at most 0.5 ms, because
the DOM walk dominates everywhere. Alpha mode costs about the same, since the
4-digit floor discards most candidates before the dataset lookup.

**The cap is reachable.** With Tier 2 unrestricted, a number-dense table with no
Ethereum content at all — the all-time Olympic medal table — produces 2262
candidates and is truncated at `MAX_MATCHES` (2000). Truncation is
document-order, so the tail of such a page gets nothing. Density triggers this,
not length. Alpha mode finds 0 on the same page.

### Dynamic pages

Content added after load is picked up by a `MutationObserver` (debounced 300 ms,
then run in an idle callback). Measured on a synthetic timeline appending 250
posts per batch:

| Feed | Posts | References | All highlighted | Latency | Scan cost |
| --- | --- | --- | --- | --- | --- |
| Growing | 2000 | 668 | yes | ~310 ms | ~2.7 ms |
| Virtualized | 400 (steady) | 134 | yes | ~1 ms | ~0.5 ms |

The rescan re-walks the whole document rather than just the mutated subtree,
which sounded expensive but measures at under 3 ms over 2000 text nodes — so
incremental rescanning is not worth the complexity yet.

## Roadmap

- Hotkey palette: fuzzy-search proposals by topic and insert the reference at the
  cursor
- New-activity hints for discussions (needs host permissions — a deliberate,
  separate opt-in)
- Related-proposal graph from the `requires` field, already captured in the data

## License

MIT

[highlight]: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
