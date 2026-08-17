# EIPeek

[![CI](https://github.com/toml01/eipeek/actions/workflows/ci.yml/badge.svg)](https://github.com/toml01/eipeek/actions/workflows/ci.yml)

A Chrome extension that annotates EIP/ERC references on any page. It highlights
references like `EIP-7702` and, on hover, shows the full title, status, and links
to the spec, forum discussion, and source.

> EIP-7702 → **EIP-7702** · Final · Core — Set Code for EOAs

Covers **1194 merged proposals plus 214 that so far exist only in an open pull
request**, across `ethereum/EIPs` and `ethereum/ERCs`, bundled with the extension.
**No network requests are made while you browse** — the dataset is in the
package, so the pages you read stay on your machine.

Have feedback? [Open a GitHub issue](https://github.com/toml01/eipeek/issues/new?template=feedback.yml)
for bugs, database corrections, feature requests, or general comments.

## Install (development)

```sh
npm install
npm run build
```

Then load `.output/chrome-mv3` via `chrome://extensions` → Developer mode →
**Load unpacked**.

Click the toolbar icon for the settings. The popup and the options page render the
same form from `src/ui/settings-form.ts`, so there is one copy of it.

Icons live in `src/public/icon/` and are generated — `npm run icons` re-renders
them, and `npm run icons -- --sheet` writes a contact sheet for checking them at
size. Note `wxt.config.ts` sets `publicDir: 'src/public'`: WXT resolves
`publicDir` against the project root, not `srcDir`, so without that line the
manifest references `icon/*.png` that never reach the bundle and Chrome refuses to
load the extension.

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
- it is not a fragment of a decimal — `7702.5` holds 7702.5, so marking `7702`
  would highlight a number nobody wrote
- word boundaries still apply, so `0x7702` and `77021` are untouched

A comma is **not** treated as grouping here: `8081,7702` is a list far more often
than a thousands group, so both numbers match. Only the alpha option reads a comma
as grouping.

Everything else is opt-in. Two settings narrow it:

| Setting | Effect |
| --- | --- |
| **Blocked sites** | Bare numbers are never marked on these hosts. Prefixed references still are, which is what makes this different from *Disabled sites*. |
| **Predict Ethereum blocks** (alpha) | Restores the conservative rules — see below. |
| **Most matches per page** | Default 2000, `0` for no limit. Truncation is document-order, so past the limit the rest of the page is skipped. |

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

**A number can refer to more than one proposal, and a claim can be invalid.**
EIP-8361 referred to two unrelated proposals while both were open. An editor ruled on
[#12081](https://github.com/ethereum/EIPs/pull/12081):

> EIP numbers cannot be self-assigned […] EIP-8361 has already been allocated to
> another proposal (PR #12075).

None of the obvious signals identified the invalid claim: CI passed on both, and
#12075 (the legitimate one) was a GitHub *draft* while #12081 was not, so filtering
drafts would have kept the wrong one. Among open proposals, PR creation order
therefore decides **display order** — never suppression. Merged proposals are
authoritative and display first. The tooltip still shows every claimant in full.

**A renumbered proposal keeps being discussed under its old number.** Tapered
Issuance Burn self-assigned 8361; its real number is **8363** — the Hegotá list
cites it that way, and its Magicians thread redirects to
`eip-8363-tapered-issuance-burn`. But X threads still say 8361. Since the point of
the extension is to resolve *what people write* without endorsing it, a proposal
is filed under the number an editor assigned and still answers to the stale ones,
via `data/aliases.json`:

```json
[{ "canonical": 8363, "alsoKnownAs": [8361], "target": { "n": 8363 }, "reason": "…" }]
```

Hovering 8361 therefore shows a card headed **EIP-8363** with *also EIP-8361* — the
reference resolves, and the reader is corrected rather than confirmed. EIP-8363
has since merged under its canonical filename, so its alias now targets the merged
proposal directly. ERC-8351 shows the open-PR form of the same situation: its file
is still `erc-8338.md`, so the source link follows that filename while the display
uses the canonical number.

That file is **curated rather than inferred mechanically**. Renumberings are rare,
and title-matching could silently merge unrelated proposals. The local maintenance
agent gathers upstream evidence and makes the judgment, while the build remains
the deterministic validator. Targets are keyed
by PR number while a proposal is open, because "the proposal at 8361" is ambiguous
while "the proposal from PR #12081" is not. Once merged, the target uses its
canonical proposal number. Every entry needs a concise factual `reason`, and the
build fails if a target has gone missing or if two proposals claim the same
canonical number. An alias *overlapping* another proposal's number is fine — that
is the contested case, and both get shown.

### Finding renumberings

Two signals, so this does not depend on someone noticing.

**Contested numbers — free, and printed by `npm run data:build`.** A number claimed
by more than one open PR is a number one side will lose, so it is the earliest
warning. Both renumberings found so far were contested first: 8361 (→ 8363) and
8338 (→ 8351). The build ends with a REVIEW block listing them and their claimants.
It cannot say what the new number will be.

**The forum thread — `npm run data:review`.** Discourse keys a thread on its
trailing topic id and rewrites the slug when the title changes, so following
`discussions-to` reveals the number the forum currently uses. That is how ERC-8351
was confirmed: `erc-8338-prediction-market-ctf-wrapper` redirects to
`erc-8351-…`.

It is **advisory, and the forum is not automatically right** — a thread keeps
whatever number its title was last edited to, so a stale slug looks exactly like a
renumbering. Of the first three disagreements it reported, only one was real:

| File | Forum | Verdict |
| --- | --- | --- |
| `erc-8338` | 8351 | real rename, confirmed |
| `erc-8190` | 8184 | stale thread — 8184 is a *merged* proposal, "LUCID encrypted mempool" |
| `erc-7989` | 7933 | probably stale — numbers are allocated upward, so a lower forum number suggests a guessed title |

So the command annotates each disagreement with whether the forum's number is
already taken, and only offers a paste-ready alias entry when it is free.

It is a separate command because it needs ~200 throttled requests. Two other
details matter:

- It **never counts a failed request as a pass.** Failures get their own list. A
  concurrent sweep during development hit HTTP 429 and silently hid the 8351 case
  entirely, which is the whole reason for the separation.
- 13 threads have no number in the title at all, so it cannot speak for those.

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

The option also restores the 4-digit minimum, thousands-comma grouping, and the
year, currency, unit, date and hyphenated-identifier filters. Terse blocks lose out either way: "thoughts on
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
| Full metadata | 439 KB | background worker, fetched only after a match |

The content script injected into every page is **~29 KB**. Metadata travels over
`runtime.sendMessage` rather than `web_accessible_resources`, so there is no
fetchable extension URL for a page to probe for.

## The dataset

`data/eips.json` is generated and committed; `data/aliases.json` is hand-written.
Both are canonical pretty JSON so their diffs stay readable. WXT imports only
`data/eips.json` and minifies it into the production `background.js` bundle;
`data/aliases.json` and its maintenance reasons are not shipped.

For AI-supervised local maintenance, run:

```sh
npm run data:maintain
```

This launches a Sol agent through the local Codex CLI and the user's current
Codex login. It runs the deterministic commands, handles transient failures,
investigates aliases and upgrade-source changes from upstream evidence, and
leaves the resulting diff for review without committing or pushing. Run
`codex login` first if the CLI is not already authenticated.

Open-PR aliases expire 180 days after the PR was opened. Younger aliases are
reviewed using upstream evidence for stagnation, obsolescence, and continued
usefulness.

Each run appends its outcome, summary, problems, and workflow recommendations
to the gitignored `data-maintenance.log` file.

The underlying commands remain available directly:

```sh
npm run data:build   # needs GITHUB_TOKEN, or `gh auth login`
npm run data:review  # advisory forum redirect check
```

The token is only for enumerating open pull requests: listing 756 PRs *with their
file lists* needs GraphQL, and GraphQL always requires auth. Everything else in
the build is unauthenticated.

The **GitHub repos are the source of truth for proposal metadata**, not
`eips.ethereum.org`:

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

Mainnet upgrade membership is rebuilt alongside proposal metadata on every run:

- Activated relationships come from EELS' mainnet protocol-history table.
- Formally scheduled relationships come from Forkcast, using the final entry in
  each upgrade-specific status history and accepting only `Scheduled`.
- BPO relationships come from BPO Meta EIPs in the downloaded EIPs archive. A
  concrete mainnet activation is required; non-Meta protocol dependencies receive
  the relationship, while the Meta records themselves do not inherit it.

EELS wins when a scheduled relationship becomes activated. Relationships attach
only to an exact EIP number, never to ERCs, aliases, or transitive `requires`.
The build deliberately fails on a new scheduled fork name until its common display
name, chronological position, and canonical hardfork Meta EIP are reviewed and
added, so a refresh cannot ship plausible-looking but incorrectly ordered or
unlinked upgrade metadata. Activated fork links come from EELS' fork-specification
column, while each BPO links to its own Meta EIP. The link target must resolve to a
merged Meta EIP in the downloaded archive.

**The build validates itself against the published site and upgrade sources** and fails on any
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

Upgrade ingestion likewise fails on source schema drift, unrecognized
relationship statuses, duplicate memberships, missing or ambiguous EIP numbers,
malformed BPO activation data, and unknown scheduled-fork chronology. The unit
suite pins representative included, scheduled, declined, multi-upgrade, BPO,
Meta-link, and ERC-negative cases.

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

`storage` only under `permissions` — for settings. No `tabs`, no
`web_accessible_resources`.

The content script matches `<all_urls>`, which both Chrome and the Chrome Web
Store count as broad host access; it is what makes the install prompt say "Read
and change your data on all websites". What the extension does with that access
is narrow: it reads text nodes and paints highlights. `INPUT`, `TEXTAREA`,
`SELECT`, `SCRIPT`, and `IFRAME` are among the skipped tags, so form fields and
passwords are never read, and no page content is stored or transmitted. Settings
go to `storage.sync`, so the browser copies them between your own signed-in
devices. See [PRIVACY.md](PRIVACY.md).

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
candidates and is truncated at the cap (2000 by default). Truncation is
document-order, so the tail of such a page gets nothing. Density triggers this,
not length. Alpha mode finds 0 on the same page. Raise or remove the cap in
options if you would rather have every match.

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
- New-activity hints for discussions (needs network access to the forum — a
  deliberate, separate opt-in)
- Related-proposal graph from the `requires` field, already captured in the data

## License

MIT

[highlight]: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
