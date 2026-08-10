import { classify, lookup, numberValidator } from '../core/dataset';
import { blockAllowsBare, findMatches, isEthHost, parseSelection } from '../core/match';
import { buildSegment, locate, partsCovering, type Segment } from '../core/segments';
import { getSettings, isSiteEnabled, onSettingsChanged } from '../core/settings';
import type { Match, Settings } from '../core/types';
import { Tooltip } from '../ui/tooltip';

const HIGHLIGHT_NAME = 'eip-ref';
const STYLE_ID = 'eipeek-highlight-style';

/** Backstop for pathological pages; the tooltip is useless past this anyway. */
const MAX_MATCHES = 2000;
const RESCAN_DEBOUNCE_MS = 300;
const HOVER_DWELL_MS = 120;
const HOVER_GRACE_MS = 200;
/** Long enough that dragging a selection does not fire on every intermediate state. */
const SELECTION_DEBOUNCE_MS = 150;

/** Subtrees that are never scanned. */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'MATH',
  'IFRAME',
  'CANVAS',
]);

/**
 * Elements that end an inline run. Deliberately a static tag list rather than
 * getComputedStyle: resolving styles for every element would be far too
 * expensive for a scan that reruns on every DOM mutation, and this is both
 * faster and deterministic.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'BUTTON', 'DD',
  'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

interface Hit {
  match: Match;
  range: Range;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // Paint-only highlighting is what lets this run on <all_urls> safely. The
    // alternative -- wrapping matches in <span>s -- mutates the page DOM and
    // breaks React reconciliation and contenteditable.
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    void start();
  },
});

async function start() {
  let settings = await getSettings();
  const tooltip = new Tooltip();

  /**
   * Hits indexed by every text node they cover. A hit can span several nodes,
   * so hovering any part of one has to resolve to the same match.
   */
  let byNode = new Map<Text, Hit[]>();
  let observer: MutationObserver | null = null;
  let rescanTimer: number | undefined;

  const scan = () => {
    byNode = new Map();
    if (!isSiteEnabled(settings, location.hostname)) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const segments = collectSegments(tooltip.hostElement);
    const isValid = numberValidator(settings.includeUnmerged);

    // Tier 2 is decided per segment, i.e. per block of text. A page-wide signal
    // is wrong in both directions on a feed: one post mentioning EIP-7702 would
    // unlock every unrelated post beside it, and a post written entirely in bare
    // numbers would never unlock. The host allowlist is the one page-wide part,
    // because it is site-level trust rather than page content.
    const trustedHost = isEthHost(location.hostname);
    const found = matchSegments(
      segments,
      isValid,
      (text) => settings.bareNumbers && (trustedHost || blockAllowsBare(text)),
    );

    if (found.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const rangeList: Range[] = [];
    for (const { segment, match } of found.slice(0, MAX_MATCHES)) {
      const from = locate(segment, match.start);
      const to = locate(segment, match.end);
      if (!from || !to) continue;

      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        continue; // Nodes changed under us; the next rescan picks it up.
      }

      const hit: Hit = { match, range };
      for (const node of partsCovering(segment, match.start, match.end)) {
        const list = byNode.get(node);
        if (list) list.push(hit);
        else byNode.set(node, [hit]);
      }
      rangeList.push(range);
    }

    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...rangeList));

    // Warm the metadata cache for what is on the page, so the first hover has
    // no latency. Pages with no matches never trigger this.
    void lookup([...new Set(found.map((f) => f.match.n))]);
  };

  const scheduleRescan = () => {
    window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => scan(), { timeout: 1000 });
      } else {
        scan();
      }
    }, RESCAN_DEBOUNCE_MS);
  };

  const observe = () => {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      // The tooltip is the one thing this extension adds to the DOM; reacting
      // to its own mutations would be an endless rescan loop.
      if (mutations.every((m) => tooltip.owns(m.target))) return;
      scheduleRescan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  // -- hover -------------------------------------------------------------
  let hoverFrame = 0;
  let dwellTimer: number | undefined;
  let active: Match | null = null;

  document.addEventListener(
    'mousemove',
    (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (byNode.size === 0) return;

        const hit = hitTest(e.clientX, e.clientY, byNode);

        if (!hit) {
          if (active && !tooltip.isPointerInside()) {
            active = null;
            window.clearTimeout(dwellTimer);
            tooltip.hide(HOVER_GRACE_MS);
          }
          return;
        }

        if (active?.n === hit.match.n && tooltip.isVisible()) return;
        active = hit.match;
        window.clearTimeout(dwellTimer);
        dwellTimer = window.setTimeout(() => {
          void tooltip.show(hit.match, hit.range.getBoundingClientRect(), settings.includeUnmerged);
        }, HOVER_DWELL_MS);
      });
    },
    { passive: true },
  );

  // -- selection lookup --------------------------------------------------
  // The manual escape hatch. Automatic bare-number matching has to stay
  // conservative -- 34 proposal numbers are plausible years -- so a reference
  // written bare on a page with no other Ethereum signal is unreachable
  // automatically. Selecting it is the user asserting it IS a reference, which
  // beats any heuristic, so every context gate is skipped here.
  let selectionTimer: number | undefined;
  let shownFromSelection = false;

  const handleSelection = () => {
    if (!settings.lookupOnSelection || !isSiteEnabled(settings, location.hostname)) return;

    const selection = document.getSelection();
    const dismiss = () => {
      if (shownFromSelection) {
        shownFromSelection = false;
        tooltip.hide(0);
      }
    };

    if (!selection || selection.isCollapsed) return dismiss();
    // Selecting text inside the tooltip -- to copy a title -- must not re-enter.
    if (selection.anchorNode && tooltip.owns(selection.anchorNode)) return;

    const match = parseSelection(selection.toString());
    if (!match) return dismiss();

    const anchor = selection.getRangeAt(0).getBoundingClientRect();
    const kind = classify(match.n, settings.includeUnmerged);
    if (kind === 'merged' || kind === 'unmerged') {
      shownFromSelection = true;
      // No dwell delay: the user has already acted.
      void tooltip.show(match, anchor, settings.includeUnmerged);
    } else if (settings.debugMode) {
      shownFromSelection = true;
      tooltip.showMiss(match.n, kind, anchor);
    } else {
      dismiss();
    }
  };

  // One event covers every way a selection happens -- drag, double-click,
  // shift+arrows, select-all -- where mouseup misses keyboard selection.
  document.addEventListener('selectionchange', () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(handleSelection, SELECTION_DEBOUNCE_MS);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shownFromSelection) {
      shownFromSelection = false;
      tooltip.hide(0);
    }
  });

  // A highlight is not a DOM node, so it has no scroll or focus events of its
  // own. Hide rather than try to keep a stale rect in sync.
  window.addEventListener('scroll', () => tooltip.hide(0), { passive: true, capture: true });

  onSettingsChanged((next: Settings) => {
    settings = next;
    injectStyle(settings);
    tooltip.hide(0);
    scan();
  });

  injectStyle(settings);
  scan();
  observe();
}

/**
 * Finds the reference under the pointer.
 *
 * Deliberately does NOT use CSS.highlights.highlightsFromPoint. That API is the
 * purpose-built one, but it is Chrome-135-only and was observed present-yet-
 * always-empty in a current Chromium build (Brave 151), which would silently
 * disable hover entirely. Resolving the caret position and confirming it
 * against the range relies only on long-standing APIs.
 */
function hitTest(x: number, y: number, byNode: Map<Text, Hit[]>): Hit | null {
  const caret = caretAt(x, y);
  if (!caret) return null;

  const hits = byNode.get(caret.node);
  if (!hits) return null;

  for (const hit of hits) {
    // isPointInRange handles ranges spanning several nodes, which matters now
    // that a match can be assembled from multiple inline runs. The geometry
    // check is still needed because the caret snaps to the nearest position.
    if (hit.range.isPointInRange(caret.node, caret.offset) && containsPoint(hit.range, x, y)) {
      return hit;
    }
  }
  return null;
}

function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) {
    return { node: pos.offsetNode as Text, offset: pos.offset };
  }
  // Older Blink/WebKit spelling.
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer as Text, offset: range.startOffset };
  }
  return null;
}

function containsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

/** The innermost block-level ancestor, which is what bounds an inline run. */
function nearestBlock(node: Text): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
  }
  return null;
}

/**
 * Walks the document, grouping consecutive inline text runs into segments that
 * never cross a block boundary.
 *
 * That boundary is the safety property: without it, a paragraph ending in "EIP"
 * followed by text starting with "7702" would read as a reference.
 *
 * Grouping is by *nearest block ancestor* rather than by flushing when a block
 * element is encountered. The difference matters on exit: in
 * `<p>...EIP</p>7702...` no block element is entered between the two runs, so a
 * flush-on-enter approach joins them and matches "EIP7702". (Whitespace between
 * the tags usually hides this, since the separator pattern excludes newlines --
 * which made it look fine right up until markup with no whitespace.)
 */
function collectSegments(tooltipHost: Element | null): Array<Segment<Text>> {
  const segments: Array<Segment<Text>> = [];
  let runs: Array<{ node: Text; text: string }> = [];
  let currentBlock: Element | null = null;

  const flush = () => {
    if (runs.length === 0) return;
    const segment = buildSegment(runs);
    runs = [];
    // Rejection happens after joining, not per node: when a site splits a
    // reference, the run holding "EIP" contains no digit at all, so a per-node
    // digit filter would discard exactly the runs that need joining.
    if (/\d/.test(segment.text)) segments.push(segment);
  };

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          // Editing surfaces: painting into them is harmless, but highlights
          // interact badly with carets and selections, and appearing to
          // corrupt someone's draft is not worth the coverage.
          if (el instanceof HTMLElement && el.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (tooltipHost && (tooltipHost === el || tooltipHost.contains(el))) {
            return NodeFilter.FILTER_REJECT;
          }
          // A <br> has no text of its own, so the ancestor comparison below
          // cannot see it; visit it purely as a boundary marker.
          return el.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    },
  );

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      flush(); // a <br>
      currentBlock = null;
      continue;
    }
    const text = node as Text;
    const block = nearestBlock(text);
    if (block !== currentBlock) {
      flush();
      currentBlock = block;
    }
    runs.push({ node: text, text: text.nodeValue ?? '' });
  }
  flush();
  return segments;
}

/**
 * One pass over every segment. `allowBareIn` is asked per segment, so Tier 2 is
 * gated by the block being matched rather than by anything found elsewhere on
 * the page -- which is also why one pass is enough. (It used to take two: Tier 1
 * everywhere to answer "is this page Ethereum-related?", then everything again
 * with Tier 2 on.)
 */
function matchSegments(
  segments: Array<Segment<Text>>,
  isValid: (n: number) => boolean,
  allowBareIn: (text: string) => boolean,
): Array<{ segment: Segment<Text>; match: Match }> {
  const out: Array<{ segment: Segment<Text>; match: Match }> = [];
  for (const segment of segments) {
    const allowBare = allowBareIn(segment.text);
    for (const match of findMatches(segment.text, { isValid, allowBare })) {
      out.push({ segment, match });
    }
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/*
 * There is deliberately no "this is already a link to the spec, skip it" guard.
 * One existed to avoid double-decorating references on eips.ethereum.org, but its
 * only real effect was suppressing highlights on Google, Bing and GitHub search
 * results -- precisely the pages where seeing a title on hover is most useful. A
 * result title there links to the spec, which made it look "already linked" while
 * showing the reader nothing but the number.
 */

function injectStyle(settings: Settings) {
  document.getElementById(STYLE_ID)?.remove();

  // Highlight pseudo-elements accept only a few properties (color,
  // background-color, text-decoration, text-shadow, -webkit-text-stroke) --
  // no cursor, no border, nothing affecting layout. So the affordance has to
  // be carried by decoration and tint alone.
  const underline = `text-decoration: underline dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    text-decoration-color: rgb(99 102 241 / 0.85);`;
  const background = 'background-color: rgb(99 102 241 / 0.14);';

  const body =
    settings.highlightStyle === 'underline'
      ? underline
      : settings.highlightStyle === 'background'
        ? background
        : `${underline}\n    ${background}`;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Must live in the page's own tree: ::highlight() resolves against the
  // document owning the highlighted ranges, not the extension's shadow root.
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) {\n    ${body}\n  }`;
  document.head.append(style);
}
