import { lookup } from '../core/dataset';
import { FEEDBACK_ISSUE_URL } from '../core/feedback';
import { aliasNumbers, linksFor, statusLine } from '../core/links';
import { canonicalLabel, isKindMismatch } from '../core/match';
import { isUnmerged, type Match, type Proposal } from '../core/types';
import { formatUpgradeItems, type UpgradeItem } from './upgrades';

const MARGIN = 8;
const MAX_WIDTH = 360;

/**
 * The hover card. Lives in a closed shadow root so that page CSS cannot reach
 * in and extension CSS cannot leak out -- the host also gets `all: initial` to
 * cut off inherited properties, which shadow boundaries do not block.
 */
export class Tooltip {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private card: HTMLDivElement | null = null;
  private hideTimer: number | undefined;
  private pointerInside = false;
  private visible = false;
  /**
   * Incremented by every show/hide request. `show` has to await a metadata
   * lookup, and without a generation check a slow lookup could resurrect a
   * tooltip the pointer had already left, or a pending hide could fire after a
   * newer show. Both were observed as flaky hover behaviour.
   */
  private generation = 0;

  get hostElement(): Element | null {
    return this.host;
  }

  owns(node: Node): boolean {
    return !!this.host && (this.host === node || this.host.contains(node));
  }

  isVisible(): boolean {
    return this.visible;
  }

  isPointerInside(): boolean {
    return this.pointerInside;
  }

  /**
   * @param includeUnmerged when false, proposals that live only in an open pull
   *   request are dropped; if that empties the list, nothing is shown.
   */
  async show(match: Match, anchor: DOMRect, includeUnmerged: boolean): Promise<void> {
    // Cancel any pending hide up front, before the await -- otherwise a hide
    // scheduled just before this call can fire while the lookup is in flight.
    window.clearTimeout(this.hideTimer);
    const generation = ++this.generation;

    const all = (await lookup([match.n])).get(match.n) ?? [];
    const entries = includeUnmerged ? all : all.filter((p) => !isUnmerged(p));
    // A hide or a different show happened while the lookup was in flight.
    if (entries.length === 0 || generation !== this.generation) return;

    const { card } = this.ensure();
    card.textContent = '';
    card.scrollTop = 0;

    // Stacked entries alone do not say why there are several, and the reader has
    // to know the number is contested before comparing the claims.
    if (entries.length > 1) {
      card.append(el('div', 'banner', `${entries.length} proposals claim ${match.n}`));
    }
    for (const proposal of entries) card.append(this.renderEntry(match, proposal));

    this.visible = true;
    this.host!.style.visibility = 'hidden';
    this.host!.style.display = 'block';
    this.position(anchor);
    this.host!.style.visibility = 'visible';
  }

  /**
   * One proposal, with its full detail. Rival claims on a contested number are
   * rendered identically and stacked -- the reader judges, the extension does not
   * pick a winner.
   */
  private renderEntry(match: Match, p: Proposal): HTMLElement {
    const entry = el('div', 'entry');
    // The padded body and the flush footer bar are siblings, so the footer's
    // background can run to both card edges.
    const body = el('div', 'body');

    // The header shows the CANONICAL number, not the one that happened to be
    // hovered: hovering a stale number should correct the reader, not confirm it.
    const head = el('div', 'head', [
      el('span', 'num', canonicalLabel(p.n, p.k)),
      el('span', `dot ${statusTone(p.s)}`),
      el('span', 'status', statusLine(p)),
    ]);
    const upgrades = formatUpgradeItems(p.u);
    if (upgrades.length) head.append(renderUpgradeGroup(upgrades));
    if (isUnmerged(p)) head.append(el('span', 'badge', 'UNMERGED'));
    if (isKindMismatch(match, p.k)) {
      head.append(el('span', 'note', `Referenced as ${match.writtenKind?.toUpperCase()}-${match.n}`));
    }
    body.append(head);

    const title = el('div', 'title');
    title.append(el('span', 'title-text', p.t));
    const also = aliasNumbers(p);
    if (also.length) {
      title.append(el('span', 'also', `also ${also.map((n) => `EIP-${n}`).join(', ')}`));
    }
    body.append(title);

    // An unmerged proposal has no spec page, so the PR is its provenance.
    if (isUnmerged(p)) {
      body.append(
        el('div', 'prov', p.prRepo ? `PR #${p.pr} · ethereum/${p.prRepo}` : `PR #${p.pr}`),
      );
    }

    // Present for ~74% of proposals.
    if (p.d) body.append(el('div', 'desc', p.d));
    entry.append(body);

    const links = el('div', 'links');
    for (const link of linksFor(p)) {
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      links.append(a);
    }
    const feedback = document.createElement('a');
    feedback.className = 'feedback-link';
    feedback.dataset.testid = 'tooltip-feedback-link';
    feedback.href = FEEDBACK_ISSUE_URL;
    feedback.target = '_blank';
    feedback.rel = 'noopener noreferrer';
    feedback.textContent = 'Mistake?';
    links.append(feedback);
    entry.append(links);
    return entry;
  }

  /**
   * Debug-mode card for a selection that parsed but did not resolve. Only ever
   * reached for a parsed reference -- showing this for arbitrary selected text
   * would pop a card on every selection the user makes.
   */
  showMiss(n: number, kind: 'hidden' | 'unknown', anchor: DOMRect): void {
    window.clearTimeout(this.hideTimer);
    this.generation++;

    const { card } = this.ensure();
    card.textContent = '';
    card.scrollTop = 0;

    const entry = el('div', 'entry');
    const body = el('div', 'body');
    // Grey rather than accent: nothing here is a resolved proposal to link to.
    const head = el('div', 'head', [el('span', 'num muted', `EIP-${n}`)]);
    if (kind === 'hidden') head.append(el('span', 'badge', 'UNMERGED'));
    body.append(head);

    body.append(
      el(
        'div',
        'desc',
        kind === 'hidden'
          ? 'Exists only in an open pull request. Enable that tier in options.'
          : 'Not in the active database.',
      ),
    );
    entry.append(body);
    card.append(entry);

    this.visible = true;
    this.host!.style.visibility = 'hidden';
    this.host!.style.display = 'block';
    this.position(anchor);
    this.host!.style.visibility = 'visible';
  }

  hide(delayMs: number): void {
    window.clearTimeout(this.hideTimer);
    // Invalidates any show() currently awaiting its lookup.
    const generation = ++this.generation;
    const run = () => {
      // A newer show() superseded this hide while it was pending.
      if (this.pointerInside || generation !== this.generation) return;
      this.visible = false;
      if (this.host) this.host.style.display = 'none';
    };
    if (delayMs <= 0) run();
    else this.hideTimer = window.setTimeout(run, delayMs);
  }

  /** Flips above the anchor when there is no room below, and clamps to the viewport. */
  private position(anchor: DOMRect): void {
    const host = this.host!;
    const card = this.card!;
    const { width, height } = card.getBoundingClientRect();

    const below = anchor.bottom + MARGIN;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - height - MARGIN);

    const left = Math.min(
      Math.max(MARGIN, anchor.left),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );

    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  }

  private ensure(): { card: HTMLDivElement } {
    if (this.card) return { card: this.card };

    const host = document.createElement('div');
    // `all: initial` first, then the properties this element actually needs --
    // later declarations win, and inherited page styles are cut off.
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; display: none;';
    this.host = host;

    const root = host.attachShadow({ mode: 'closed' });
    this.root = root;

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.append(style);

    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'tooltip');
    root.append(card);
    this.card = card;

    // Let the pointer travel into the card to click a link or scroll a stack of
    // rival claims without it closing.
    card.addEventListener('mouseenter', () => {
      this.pointerInside = true;
      window.clearTimeout(this.hideTimer);
    });
    card.addEventListener('mouseleave', () => {
      this.pointerInside = false;
      this.hide(120);
    });

    document.body.append(host);
    return { card };
  }
}

function el(tag: string, cls: string, content?: string | Node[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (typeof content === 'string') node.textContent = content;
  else if (content) node.append(...content);
  return node;
}

/** One compact, non-breaking upgrade cluster for the header metadata line. */
function renderUpgradeGroup(upgrades: UpgradeItem[]): HTMLElement {
  const group = el('span', 'upgrades');
  const separator = el('span', 'upgrade-separator', '·');
  separator.setAttribute('aria-hidden', 'true');
  group.append(separator, forkIcon());

  upgrades.forEach((upgrade, index) => {
    if (index > 0) group.append(document.createTextNode(', '));

    const name = document.createElement('a');
    name.className = 'upgrade-name';
    name.href = upgrade.url;
    name.target = '_blank';
    name.rel = 'noopener noreferrer';
    name.dataset.testid = 'tooltip-upgrade-link';
    if (upgrade.status === 'scheduled') {
      const scheduledLabel = `${upgrade.name} (scheduled)`;
      name.classList.add('scheduled');
      name.setAttribute('aria-label', scheduledLabel);
      name.title = scheduledLabel;
    }
    name.textContent = upgrade.name;
    group.append(name);
  });

  return group;
}

/** Lucide GitFork, ISC licensed: https://lucide.dev/icons/git-fork */
function forkIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('upgrade-icon');
  svg.setAttribute('data-testid', 'tooltip-upgrade-icon');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const [cx, cy] of [
    ['12', '18'],
    ['6', '6'],
    ['18', '6'],
  ] as const) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', '3');
    svg.append(circle);
  }
  for (const d of ['M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9', 'M12 12v3']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }

  return svg;
}

/**
 * Status dot colour. Groups the seven statuses the dataset actually carries into
 * settled / in-flight / abandoned; anything unrecognised reads as abandoned
 * rather than claiming a proposal is settled.
 */
function statusTone(status: string): 'ok' | 'wip' | 'cold' {
  if (status === 'Final' || status === 'Living') return 'ok';
  if (status === 'Draft' || status === 'Review' || status === 'Last Call') return 'wip';
  return 'cold';
}

const CSS_TEXT = `
  :host { all: initial; }
  .card {
    box-sizing: border-box;
    max-width: ${MAX_WIDTH}px;
    border-radius: 10px;
    /* Clips the footer bar's background to the rounded corners. The following
       overflow-y re-opens the vertical axis, which a stack of rival claims
       needs -- a scroll container still clips to the radius. */
    overflow: hidden;
    max-height: 70vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid rgb(0 0 0 / 0.09);
    background: #fff;
    color: #14141a;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.12);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-align: left;
  }
  .banner {
    padding: 6px 13px;
    background: #fdf0d0;
    color: #8a6d00;
    font-size: 11px;
    font-weight: 550;
  }
  .entry + .entry { border-top: 1px solid rgb(0 0 0 / 0.09); }
  .body { padding: 11px 13px 12px; }
  /* Wraps only when the badge and the mix-up note land on the same row. */
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 5px; }
  .num {
    font: 600 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.04em;
    color: #4f46e5;
  }
  .num.muted { color: #6b6b76; }
  .dot { flex: none; width: 5px; height: 5px; border-radius: 999px; }
  .dot.ok { background: #16a34a; }
  .dot.wip { background: #8a6d00; }
  .dot.cold { background: #6b6b76; }
  .status { font-size: 11px; color: #6b6b76; }
  .upgrades {
    display: inline-flex;
    flex: none;
    align-items: center;
    color: #6b6b76;
    font-size: 11px;
    white-space: nowrap;
  }
  .upgrade-separator, .upgrade-icon { flex: none; margin-right: 4px; }
  .upgrade-name { color: inherit; text-decoration: none; }
  .upgrade-name.scheduled { font-style: italic; }
  a.upgrade-name:hover { color: #4f46e5; text-decoration: underline; }
  a.upgrade-name:focus-visible {
    outline: 2px solid #4f46e5;
    outline-offset: 2px;
    border-radius: 2px;
  }
  .badge, .note { margin-left: auto; }
  .badge + .note { margin-left: 0; }
  .badge {
    padding: 1px 6px;
    border-radius: 999px;
    background: #fdf0d0;
    color: #8a6d00;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .note { font-size: 11px; color: #8a6d00; white-space: nowrap; }
  .title { display: flex; align-items: baseline; gap: 8px; }
  .title-text {
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .also {
    margin-left: auto;
    color: #6b6b76;
    font-size: 11px;
    white-space: nowrap;
  }
  .prov { margin-top: 5px; font-size: 11.5px; color: #6b6b76; }
  .desc { margin-top: 5px; color: #55555f; font-size: 12px; text-wrap: pretty; }
  .links {
    display: flex;
    gap: 14px;
    padding: 8px 13px;
    background: #fafafb;
    border-top: 1px solid rgb(0 0 0 / 0.07);
  }
  .links a {
    color: #4f46e5;
    text-decoration: none;
    font-size: 12px;
    font-weight: 500;
  }
  .links a:hover { text-decoration: underline; }
  .links .feedback-link {
    margin-left: auto;
    color: #777783;
    font-size: 11px;
    font-weight: 400;
  }
  .links .feedback-link:hover { color: #4f46e5; }
  .links .feedback-link:focus-visible {
    outline: 2px solid #4f46e5;
    outline-offset: 2px;
    border-radius: 2px;
  }

  @media (prefers-color-scheme: dark) {
    .card {
      background: #1f2023;
      color: #e8e8ea;
      border-color: rgb(255 255 255 / 0.12);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.5);
    }
    .banner { background: #4a3c10; color: #f0cf6a; }
    .entry + .entry { border-top-color: rgb(255 255 255 / 0.12); }
    .num { color: #9b91ff; }
    .num.muted { color: #9a9aa2; }
    .dot.ok { background: #4ade80; }
    .dot.wip { background: #f0cf6a; }
    .dot.cold { background: #9a9aa2; }
    .status, .also, .prov, .upgrades { color: #9a9aa2; }
    .badge { background: #4a3c10; color: #f0cf6a; }
    .note { color: #f0cf6a; }
    .desc { color: #b8b8c0; }
    a.upgrade-name:hover { color: #b7b0ff; }
    a.upgrade-name:focus-visible { outline-color: #b7b0ff; }
    .links { background: #26272b; border-top-color: rgb(255 255 255 / 0.08); }
    .links a { color: #9b91ff; }
    .links .feedback-link { color: #a7a7b0; }
    .links .feedback-link:hover { color: #b7b0ff; }
    .links .feedback-link:focus-visible { outline-color: #b7b0ff; }
  }
`;
