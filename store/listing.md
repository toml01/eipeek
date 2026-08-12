# Chrome Web Store listing — EIPeek

Source of truth for all facts: `README.md` (regenerate this doc if the counts
in there drift — they're rebuilt periodically by `npm run data:build`).

---

## 1. Short description

**Character count: 124 / 132**

```
Hover any EIP/ERC reference for its title, status, and links. Offline dataset, zero network requests, zero host permissions.
```

---

## 2. Detailed description

**Character count: 1626 / 16000**

```
EIPeek finds EIP and ERC references anywhere on a web page — EIP-7702, ERC-20, EIP 3074, even bare numbers like 7702 (if you turn that on) — and gives you a hover card with the all the deatils you need instead of opening a new tab and search!

Hover on "EIP-7702" on a GitHub issue, an X thread, or a pasted-in Discord message and you get the full title ("Set Code for EOAs"), its status (Draft, Review, Last Call, Final, Stagnant, Withdrawn, or Living), its category, and links to the spec, the Ethereum Magicians forum thread, and the GitHub source.

FEATURES

- Covers 1189 merged EIPs and ERCs, plus 205 proposals that exist only as open pull requests — the ones people are actively discussing before a number is even final.
- Doesn't touch the page. Nothing is inserted or wrapped, so it can't break the site underneath it.
- When a number is contested, you see every PR that claims it — not just one.
- Renumbered proposals still resolve. Hover the old number and you get the current one.
- Bare-number matching (7702, no "EIP-" needed) is available as an opt-in, off by default so a page saying "back in 2020" doesn't light up if you don't want it to.
- Select any number on a page to look it up on demand, prefix or not.
- Per-site blocking, an adjustable per-page match limit, and a debug mode for when something doesn't resolve.
- No network requests. No host permissions. No tabs permission. All local.
```

---

## 3. Category

**Tools**

Not "Developer Tools" — the audience is broader than software developers.
Anyone who runs into an "EIP-xxxx" or "ERC-xxxx" mention while reading —
on GitHub, X, a news article, a forum post — gets value from this, including
traders, researchers, and journalists who never write code. The Chrome Web
Store groups the generic **Tools** category under Productivity (alongside
Workflow & Planning), which fits a reference/lookup utility without narrowing
the audience to engineers.

---

## 4. Single purpose statement

*(For the Developer Dashboard's Privacy Practices tab.)*

```
EIPeek detects EIP and ERC references in the text of the current web page and shows each proposal's title, status, and related links in a hover tooltip.
```

---

## 5. Permission justification

*(`storage` — the extension's only requested permission.)*

```
The storage permission stores the user's own extension settings — the bare-number matching toggle, the blocked-sites list, the per-page match cap, and debug mode — locally in the browser. It is not used to collect, sync, or transmit any personal data or browsing activity; the extension makes no network requests and has no host permissions.
```
