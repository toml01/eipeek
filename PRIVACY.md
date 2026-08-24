# EIPeek — Privacy Policy

**Effective date: 24 August 2026**

EIPeek is a browser extension that highlights EIP and ERC references on the
pages you read, and shows each proposal's title, status, and links in a hover
card.

**EIPeek makes no network requests because of the pages you browse.** There is
no EIPeek server, analytics, telemetry, or advertising. Nothing you read is
collected, recorded, or sold. An on-by-default daily background database check
contacts GitHub, independently of browsing, and a manual check happens when you
click **Check for updates**. Both are described below.

## Page content

To find references such as `EIP-7702` or `ERC-20`, the extension reads the
visible text of the page in your browser, while you are on the page. This is the
data category the Chrome Web Store calls **website content**, and it is the only
category EIPeek touches.

What happens to that text:

- It is examined in memory and then discarded. It is never stored and never
  transmitted.
- Matches are drawn with the CSS Custom Highlight API. The page itself is not
  changed — no text is wrapped, moved, or rewritten.
- These elements are skipped entirely, so their contents are never read:
  `INPUT`, `TEXTAREA`, `SELECT`, `OPTION`, `SCRIPT`, `STYLE`, `NOSCRIPT`,
  `TEMPLATE`, `IFRAME`, `CANVAS`, `SVG`, and `MATH`. Passwords, form fields, and
  other typed input are therefore outside what the extension can see.
- If you turn on look-up on selection, the text you select is read the same way,
  only when you select it, and is likewise discarded.

The extension needs access to all sites because an EIP number can be mentioned
on any page — a blog, a forum, a news article, a code host, or a chat log. There
is no list of sites that can cover this.

## The website address

The extension reads the hostname of the page (for example `github.com`) to
compare it with your own site lists, and to decide whether to run there. The
hostname is used in the page and then discarded. No address, page title, or
visit time is stored or sent, and the extension does not read your browsing
history.

## Your settings

The extension stores your own settings with the browser's extension storage
API (`chrome.storage.sync`):

`enabled`, `bareNumbers`, `predictEthBlocks`, `includeUnmerged`,
`lookupOnSelection`, `debugMode`, `highlightStyle`, `maxMatches`,
`disabledSites`, `bareNumberBlockedSites`, and the automatic database-check
preference.

`disabledSites` and `bareNumberBlockedSites` are the hostnames you type into the
site lists yourself.

Because the API is `sync`, your browser copies these settings between the
devices where you are signed in, if you have browser sync switched on. Your
browser does this, not the extension. The developer never receives them and has
no way to read them.

To erase the settings, clear the extension's data in your browser, or remove the
extension. Removing the extension deletes them.

## The proposal data

The EIP and ERC dataset — titles, statuses, categories, and links — is built
before release and is included in the extension package as a permanent fallback.
The extension reads it from your own disk during normal browsing.

Automatic database checks are enabled by default. Chrome schedules the first one
at a randomized time within 1 through 1440 minutes, then approximately once per
day. Each automatic check first requests a fixed public version-hint file in
EIPeek's GitHub repository through the GitHub REST API. The hint is limited to 4
KiB and is used only to decide whether the signed database file might be newer.
The larger signed file is requested only when the hint is above the highest
version EIPeek has already accepted, and it is never trusted merely because the
hint named it. Failed checks retry only at the next daily alarm.

You can turn off **Update the database automatically each day** in the popup or
options page. Turning it off clears the daily alarm and stops automatic checks;
turning it back on creates a new randomized daily schedule. Clicking **Check for
updates** remains an explicit manual check of the fixed signed database file.

These requests use no login, cookie, token, or other credential and send no
referrer. Like any web service, GitHub receives your IP address, request time,
and standard HTTP request metadata such as the browser user agent and extension
origin. GitHub handles that data under its own privacy policy.

The requests contain **no page content, page address, browsing history, selected
text, or extension setting**. No current tab information is read or sent. The
downloaded file contains proposal data only. EIPeek verifies its ECDSA P-256
signature and strict schema before storing it in `chrome.storage.local` on that
device. It is not synced to other devices and is never exposed to the pages you
visit. A failed check leaves the active database unchanged. **Restore bundled
database** selects the package copy again.

Install/update, browser startup, and worker startup reconcile the alarm schedule
but do not fetch. Page load, scanning, highlighting, hover, tooltip use, status
display, and restore never fetch. Only delivery of the named daily alarm or an
explicit manual check from an extension settings page can make these requests.

The worker uses persistent database storage only after Chrome confirms it is
restricted to trusted extension contexts. If that access-level operation is not
supported or is rejected, bundled proposal lookups continue locally while
database update and restore actions fail safely without reading or writing that
storage area.

## Changes

If this policy changes, the new version is published at this address, with a new
effective date.

## Contact

The extension's feedback link opens a GitHub issue form in a new tab when you
click it. EIPeek
does not collect or send feedback itself; anything you submit is handled by
GitHub under its own policies.
