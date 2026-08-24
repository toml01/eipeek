/**
 * Regenerates data/eips.json from the upstream EIP and ERC repositories.
 *
 * Run with `npm run data:build`. The output is committed so that normal builds
 * are reproducible and work offline.
 *
 * Source-of-truth note: eips.ethereum.org is a Jekyll build *of* these repos,
 * so it is downstream by construction and cannot be fresher. Its `/all` index
 * also omits `discussions-to` and per-proposal `description` entirely, and its
 * Atom feed is empty boilerplate (jekyll-feed over `site.posts`, but EIPs are
 * pages). So the repos are the source -- and the rendered site is used purely
 * as an independent validator at the end of this script.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  constructDatabaseFromSources,
  reconstructCommittedDatabase,
} from './database-payload';

const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT_JSON = path.join(ROOT, 'data', 'eips.json');
const OUT_NUMBERS = path.join(ROOT, 'src', 'core', 'numbers.generated.ts');
const OUT_DATABASE_GENERATED = path.join(ROOT, 'src', 'core', 'database.generated.ts');

/** Maximum age for an alias targeting an open pull request. */
export const DEFAULT_STALE_ALIAS_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const SOURCES = [
  // ERCs first, so that the EIPs copy wins the sole real cross-repo collision
  // (EIP-1 exists in both). Later writes overwrite earlier ones.
  { repo: 'ERCs', tarDir: 'ERCs-master', subdir: 'ERCS', kind: 'erc' as const },
  { repo: 'EIPs', tarDir: 'EIPs-master', subdir: 'EIPS', kind: 'eip' as const },
];

const EELS_PROTOCOL_HISTORY =
  'https://raw.githubusercontent.com/ethereum/execution-specs/forks/amsterdam/docs/specs/protocol_history.md';
const FORKCAST_TARBALL =
  'https://codeload.github.com/ethereum/forkcast/tar.gz/refs/heads/main';

export type UpgradeStatus = 'included' | 'scheduled';

export interface Upgrade {
  /** common upgrade name */ n: string;
  /** whether the upgrade has activated or is formally scheduled */ s: UpgradeStatus;
  /** canonical hardfork Meta EIP */ m: number;
}

/** An upstream relationship before it is attached to a compact proposal. */
export interface UpgradeRelationship {
  proposal: number;
  name: string;
  status: UpgradeStatus;
  /** canonical hardfork Meta EIP */ meta: number;
  /** Activation chronology for included upgrades; fork chronology for scheduled ones. */
  order: number;
  source: string;
}

/** A single proposal, with short keys to keep the bundled JSON small. */
export interface Proposal {
  n: number;
  /** title */ t: string;
  /** description (absent for ~26% of proposals) */ d: string;
  /** status */ s: string;
  /** type */ ty: string;
  /** category (absent for Meta/Informational) */ c: string;
  /** which repo it lives in -- determines the GitHub source link */ k: 'eip' | 'erc';
  /** discussions-to URL (absent for ~5%) */ disc: string;
  /** created date */ cr: string;
  /** requires */ req: number[];
  /** activated and formally scheduled mainnet upgrades */
  u?: Upgrade[];

  // -- present only on proposals that live in an open pull request ----------
  /** PR number; its absence is what marks a proposal as merged */ pr?: number;
  /** which repo the PR targets */ prRepo?: 'EIPs' | 'ERCs';
  /** head commit, so the source link is stable */ prRef?: string;
  /** head repo (a fork), needed to fetch and link the file */ prHead?: string;
  /** PR creation time -- decides display order among rival claims */ prOpened?: string;
  /**
   * The number in the PR's filename, when it differs from the canonical `n`.
   * Needed for the source link: an open PR can retain a self-assigned filename
   * after editors assign the proposal a different canonical number.
   */
  prFileN?: number;

  /**
   * Other numbers this proposal is referred to by, from data/aliases.json.
   * Hand-curated: renumberings are rare and automated title matching would risk
   * silently merging unrelated proposals.
   */
  aka?: number[];
}

/**
 * One hand-written entry in data/aliases.json.
 *
 * `canonical` is the number the proposal is properly known by, which is not
 * always the number its file is named after: an editor can reassign a number
 * after an author self-assigned one, and the file often lags.
 */
interface AliasEntry {
  canonical: number;
  /** Numbers still used for this proposal in the wild. */
  alsoKnownAs: number[];
  target: { pr?: number; repo?: 'EIPs' | 'ERCs'; n?: number };
  reason: string;
}

const KNOWN_STATUSES = new Set([
  'Draft',
  'Review',
  'Last Call',
  'Final',
  'Stagnant',
  'Withdrawn',
  'Living',
]);

interface Frontmatter {
  eip?: number | string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  category?: string;
  'discussions-to'?: string;
  created?: string | Date;
  requires?: number | string;
}

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

/**
 * Splits the YAML frontmatter block off a proposal markdown file.
 *
 * Deliberately parsed with js-yaml rather than line-splitting: 16 titles are
 * YAML-quoted because they contain a colon (`title: "Hardfork Meta: Homestead"`),
 * and long `author`/`description` values wrap across lines. A hand-rolled
 * parser silently keeps the quotes and ships them into the UI.
 */
function parseFrontmatter(raw: string): Frontmatter | null {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = raw.slice(3, end);
  try {
    const parsed = yaml.load(block, { schema: yaml.JSON_SCHEMA });
    return parsed && typeof parsed === 'object' ? (parsed as Frontmatter) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** Remote data only carries links that are safe to expose as clickable URLs. */
function httpsUrlOrEmpty(v: unknown): string {
  const value = str(v);
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
      ? value
      : '';
  } catch {
    return '';
  }
}

const UPGRADE_NAMES: Readonly<Record<string, string>> = {
  Cancun: 'Dencun',
  Prague: 'Pectra',
  Osaka: 'Fusaka',
  Shanghai: 'Shapella',
  Paris: 'The Merge',
  Amsterdam: 'Glamsterdam',
  Hegota: 'Hegotá',
};

/** Converts execution/consensus layer fork names to their common upgrade names. */
export function normalizeUpgradeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('upgrade name is empty');
  return UPGRADE_NAMES[trimmed] ?? trimmed;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

/** Reads the one non-struck-through Meta EIP link from an EELS fork-spec cell. */
function eelsMetaEip(cell: string, upgrade: string): number {
  const active = cell.replace(/~+\[[^\]]+\]\([^)]+\)~+/g, '');
  const matches = [
    ...active.matchAll(/\[[^\]]*\bMeta EIP-(\d+)\]\((https:\/\/eips\.ethereum\.org\/EIPS\/eip-(\d+))\)/gi),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `EELS protocol history: ${upgrade} must have exactly one active hardfork Meta EIP`,
    );
  }
  const labelNumber = Number(matches[0]![1]);
  const urlNumber = Number(matches[0]![3]);
  if (!Number.isSafeInteger(labelNumber) || labelNumber <= 0 || labelNumber !== urlNumber) {
    throw new Error(`EELS protocol history: invalid hardfork Meta EIP for ${upgrade}`);
  }
  return labelNumber;
}

/**
 * Parses activated mainnet membership from EELS' protocol history table.
 *
 * It intentionally stops at the end of the mainnet table, excluding the later
 * "Clarifications without a protocol release" section.
 */
export function parseEelsProtocolHistory(markdown: string): UpgradeRelationship[] {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === '## Mainnet hardforks');
  if (heading === -1) throw new Error('EELS protocol history: missing mainnet hardforks heading');

  const header = lines.findIndex(
    (line, index) =>
      index > heading &&
      splitMarkdownRow(line).join('|') ===
        'Version and Code Name|Block No.|Released|Incl EIPs|Fork Specifications|Blog',
  );
  if (header === -1) throw new Error('EELS protocol history: mainnet table header changed');
  if (!/^\|(?:\s*:?-+:?\s*\|){6}$/.test(lines[header + 1]?.trim() ?? '')) {
    throw new Error('EELS protocol history: malformed mainnet table separator');
  }

  const relationships: UpgradeRelationship[] = [];
  const seenUpgrades = new Set<string>();
  const seenRelationships = new Set<string>();
  let rows = 0;

  for (let index = header + 2; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim().startsWith('|')) break;
    const cells = splitMarkdownRow(line);
    if (cells.length !== 6) {
      throw new Error(`EELS protocol history: row ${index + 1} has ${cells.length} columns, expected 6`);
    }
    rows++;

    const rawName = cells[0]!.replace(/<[^>]+>/g, '').trim();
    if (!rawName) throw new Error(`EELS protocol history: row ${index + 1} has no upgrade name`);
    const name = normalizeUpgradeName(rawName);
    if (seenUpgrades.has(name)) {
      throw new Error(`EELS protocol history: duplicate upgrade ${JSON.stringify(name)}`);
    }
    seenUpgrades.add(name);

    const includedCell = cells[3]!;
    const eipPrefixes = [...includedCell.matchAll(/EIP-/g)];
    const proposalMatches = [...includedCell.matchAll(/\bEIP-([A-Za-z0-9]+)\b/g)];
    if (eipPrefixes.length !== proposalMatches.length) {
      throw new Error(`EELS protocol history: cannot parse every included EIP for ${name}`);
    }
    const proposals = proposalMatches.map((match) => {
      if (!/^\d+$/.test(match[1]!)) {
        throw new Error(`EELS protocol history: invalid included ${match[0]} for ${name}`);
      }
      const proposal = Number(match[1]);
      if (!Number.isSafeInteger(proposal) || proposal <= 0) {
        throw new Error(`EELS protocol history: invalid included ${match[0]} for ${name}`);
      }
      return proposal;
    });
    if (proposals.length === 0) continue;

    const released = /\b(\d{4}-\d{2}-\d{2})\b/.exec(cells[2]!)?.[1];
    const order = released ? Date.parse(`${released}T00:00:00Z`) : Number.NaN;
    if (!Number.isFinite(order)) {
      throw new Error(`EELS protocol history: ${name} has included EIPs but no release date`);
    }
    const meta = eelsMetaEip(cells[4]!, name);

    for (const proposal of proposals) {
      const key = `${proposal}\u0000${name}`;
      if (seenRelationships.has(key)) {
        throw new Error(`EELS protocol history: duplicate relationship EIP-${proposal} / ${name}`);
      }
      seenRelationships.add(key);
      relationships.push({ proposal, name, status: 'included', meta, order, source: 'EELS' });
    }
  }

  if (rows === 0 || relationships.length === 0) {
    throw new Error('EELS protocol history: mainnet table is empty');
  }
  return relationships;
}

const FORKCAST_STATUSES = new Set([
  'Proposed',
  'Considered',
  'Scheduled',
  'Declined',
  'Included',
  'Withdrawn',
  'Informational',
  'Networking',
]);

// Forkcast stores relationships by combined fork name. The explicit roadmap
// order makes chronology reviewable and ensures a new scheduled name fails the
// build until its position is known.
const SCHEDULED_UPGRADES = new Map<string, { order: number; meta: number }>([
  ['Dencun', { order: 0, meta: 7569 }],
  ['Pectra', { order: 1, meta: 7600 }],
  ['Fusaka', { order: 2, meta: 7607 }],
  ['Glamsterdam', { order: 3, meta: 7773 }],
  ['Hegotá', { order: 4, meta: 8081 }],
]);
const SCHEDULED_ORDER_BASE = 4_000_000_000_000;

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/** Parses the formally scheduled relationships from one Forkcast EIP record. */
export function parseForkcastEip(raw: string, filename: string): UpgradeRelationship[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Forkcast ${filename}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const eip = record(parsed, `Forkcast ${filename}`);
  const proposal = eip.id;
  if (!Number.isInteger(proposal) || (proposal as number) <= 0) {
    throw new Error(`Forkcast ${filename}: "id" must be a positive integer`);
  }
  if (filename !== `${proposal}.json`) {
    throw new Error(`Forkcast ${filename}: id ${proposal} does not match filename`);
  }
  if (!Array.isArray(eip.forkRelationships)) {
    throw new Error(`Forkcast ${filename}: "forkRelationships" must be an array`);
  }

  const relationships: UpgradeRelationship[] = [];
  const seenForks = new Set<string>();
  for (let forkIndex = 0; forkIndex < eip.forkRelationships.length; forkIndex++) {
    const fork = record(
      eip.forkRelationships[forkIndex],
      `Forkcast ${filename} forkRelationships[${forkIndex}]`,
    );
    if (typeof fork.forkName !== 'string' || !fork.forkName.trim()) {
      throw new Error(`Forkcast ${filename} forkRelationships[${forkIndex}]: invalid forkName`);
    }
    const name = normalizeUpgradeName(fork.forkName);
    if (seenForks.has(name)) {
      throw new Error(`Forkcast ${filename}: duplicate relationship for ${name}`);
    }
    seenForks.add(name);
    if (!Array.isArray(fork.statusHistory) || fork.statusHistory.length === 0) {
      throw new Error(`Forkcast ${filename} ${name}: statusHistory must be a non-empty array`);
    }

    for (let statusIndex = 0; statusIndex < fork.statusHistory.length; statusIndex++) {
      const statusEntry = record(
        fork.statusHistory[statusIndex],
        `Forkcast ${filename} ${name} statusHistory[${statusIndex}]`,
      );
      if (typeof statusEntry.status !== 'string' || !FORKCAST_STATUSES.has(statusEntry.status)) {
        throw new Error(
          `Forkcast ${filename} ${name}: unrecognized status ${JSON.stringify(statusEntry.status)}`,
        );
      }
    }

    const latest = record(fork.statusHistory.at(-1), `Forkcast ${filename} ${name} latest status`);
    if (latest.status !== 'Scheduled') continue;
    const upgrade = SCHEDULED_UPGRADES.get(name);
    if (!upgrade) {
      throw new Error(`Forkcast ${filename}: no metadata is known for scheduled ${name}`);
    }
    relationships.push({
      proposal: proposal as number,
      name,
      status: 'scheduled',
      meta: upgrade.meta,
      order: SCHEDULED_ORDER_BASE + upgrade.order,
      source: `Forkcast ${filename}`,
    });
  }
  return relationships;
}

export interface BpoMetaUpgrade {
  meta: number;
  name: string;
  status: UpgradeStatus;
  /** Unix activation time in milliseconds; absent for an incomplete draft. */
  activation?: number;
  requires: number[];
}

/** Extracts BPO activation data from a BPO Meta EIP, ignoring other EIPs. */
export function parseBpoMeta(raw: string): BpoMetaUpgrade | null {
  const fm = parseFrontmatter(raw);
  if (!fm) return null;
  const title = str(fm.title);
  const looksLikeBpoMeta = /\bBPO\d*\b/i.test(title) && /Hardfork Meta/i.test(title);
  if (str(fm.type) !== 'Meta') {
    if (looksLikeBpoMeta) throw new Error(`${title}: BPO hardfork record is not a Meta EIP`);
    return null;
  }
  const titleMatch = /^Hardfork Meta\s*-\s*BPO(\d+)$/i.exec(title);
  if (!titleMatch) {
    if (looksLikeBpoMeta) throw new Error(`${title}: unrecognized BPO Meta EIP title`);
    return null;
  }

  const meta = Number(fm.eip);
  if (!Number.isInteger(meta) || meta <= 0) throw new Error('BPO Meta EIP has an invalid eip number');
  const bpoNumber = Number(titleMatch[1]);
  if (!Number.isInteger(bpoNumber) || bpoNumber <= 0) {
    throw new Error(`EIP-${meta}: invalid BPO number in title`);
  }
  const status = str(fm.status);
  if (!KNOWN_STATUSES.has(status)) {
    throw new Error(`EIP-${meta}: unrecognized BPO Meta EIP status ${JSON.stringify(status)}`);
  }
  if (!/\bmainnet\b/i.test(str(fm.description))) {
    throw new Error(`EIP-${meta}: BPO Meta EIP does not identify a mainnet activation`);
  }

  const identifiers = [...raw.matchAll(/^\|\s*BPO Identifier\s*\|\s*([^|]+?)\s*\|\s*$/gim)];
  if (identifiers.length !== 1 || identifiers[0]![1]!.trim().toUpperCase() !== `BPO${bpoNumber}`) {
    throw new Error(`EIP-${meta}: BPO Identifier does not match the title`);
  }
  const activationRows = [
    ...raw.matchAll(/^\|\s*Activation Time \(UTC\)\s*\|\s*([^|]*?)\s*\|\s*$/gim),
  ];
  if (activationRows.length !== 1) {
    throw new Error(`EIP-${meta}: expected exactly one BPO activation time`);
  }
  const activationValue = activationRows[0]![1]!.trim();
  let seconds: number | undefined;
  if (/^\d+$/.test(activationValue)) {
    seconds = Number(activationValue);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error(`EIP-${meta}: invalid BPO activation time`);
    }
  } else if (activationValue !== '<!-- TODO -->') {
    throw new Error(`EIP-${meta}: invalid BPO activation time ${JSON.stringify(activationValue)}`);
  }
  if (status === 'Final' && seconds === undefined) {
    throw new Error(`EIP-${meta}: Final BPO Meta EIP has no concrete activation time`);
  }

  return {
    meta,
    name: `BPO${bpoNumber}`,
    status: status === 'Final' ? 'included' : 'scheduled',
    activation: seconds === undefined ? undefined : seconds * 1000,
    requires: parseBpoRequires(meta, fm.requires),
  };
}

function parseBpoRequires(meta: number, value: unknown): number[] {
  const tokens = str(value).split(/[,\s]+/).filter(Boolean);
  const requires = tokens.map((token) => {
    if (!/^\d+$/.test(token)) {
      throw new Error(`EIP-${meta}: invalid BPO requirement ${JSON.stringify(token)}`);
    }
    const required = Number(token);
    if (!Number.isSafeInteger(required) || required <= 0) {
      throw new Error(`EIP-${meta}: invalid BPO requirement ${JSON.stringify(token)}`);
    }
    return required;
  });
  if (new Set(requires).size !== requires.length) {
    throw new Error(`EIP-${meta}: duplicate BPO requirement`);
  }
  return requires;
}

async function collect(): Promise<Map<number, Proposal>> {
  await mkdir(CACHE, { recursive: true });
  const proposals = new Map<number, Proposal>();
  let movedStubs = 0;

  for (const { repo, tarDir, subdir, kind } of SOURCES) {
    const tarball = path.join(CACHE, `${repo}.tar.gz`);
    log(`  fetching ethereum/${repo}...`);
    await download(
      `https://codeload.github.com/ethereum/${repo}/tar.gz/refs/heads/master`,
      tarball,
    );

    // Extract only the proposals directory. An exact member prefix (not a glob)
    // keeps this working on both BSD tar (macOS) and GNU tar.
    await rm(path.join(CACHE, tarDir), { recursive: true, force: true });
    await exec('tar', ['-xzf', tarball, '-C', CACHE, `${tarDir}/${subdir}`]);

    const dir = path.join(CACHE, tarDir, subdir);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    let kept = 0;

    for (const file of files) {
      const fm = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'));
      if (!fm) {
        log(`    ! no parseable frontmatter: ${subdir}/${file}`);
        continue;
      }
      // 365 files are two-line "Moved" pointers left behind when application
      // standards were split out into the ERCs repo. They carry no metadata.
      if (str(fm.status) === 'Moved') {
        movedStubs++;
        continue;
      }
      const n = Number(fm.eip);
      if (!Number.isInteger(n) || n <= 0) {
        log(`    ! bad eip number in ${subdir}/${file}`);
        continue;
      }
      const title = str(fm.title);
      if (!title) {
        log(`    ! missing title in ${subdir}/${file}`);
        continue;
      }
      proposals.set(n, {
        n,
        t: title,
        d: str(fm.description),
        s: str(fm.status),
        ty: str(fm.type),
        c: str(fm.category),
        k: kind,
        disc: str(fm['discussions-to']),
        cr: str(fm.created),
        req: str(fm.requires)
          .split(/[,\s]+/)
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0),
      });
      kept++;
    }
    log(`    ${files.length} files -> ${kept} live proposals`);
  }

  log(`  skipped ${movedStubs} "Moved" stubs`);
  return proposals;
}

async function collectBpoMetas(): Promise<BpoMetaUpgrade[]> {
  const dir = path.join(CACHE, 'EIPs-master', 'EIPS');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
  const metas: BpoMetaUpgrade[] = [];
  for (const file of files) {
    const meta = parseBpoMeta(await readFile(path.join(dir, file), 'utf8'));
    if (meta) metas.push(meta);
  }
  if (metas.length === 0) throw new Error('EIPs archive: no BPO Meta EIPs found');
  return metas;
}

async function fetchEelsRelationships(): Promise<UpgradeRelationship[]> {
  const res = await fetch(EELS_PROTOCOL_HISTORY);
  if (!res.ok) throw new Error(`EELS protocol history: HTTP ${res.status}`);
  return parseEelsProtocolHistory(await res.text());
}

async function collectForkcastRelationships(): Promise<UpgradeRelationship[]> {
  const tarball = path.join(CACHE, 'forkcast.tar.gz');
  const tarDir = 'forkcast-main';
  log('    fetching ethereum/forkcast...');
  await download(FORKCAST_TARBALL, tarball);
  await rm(path.join(CACHE, tarDir), { recursive: true, force: true });
  await exec('tar', ['-xzf', tarball, '-C', CACHE, `${tarDir}/src/data/eips`]);

  const dir = path.join(CACHE, tarDir, 'src', 'data', 'eips');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('Forkcast: no EIP data files found');
  const seenIds = new Set<number>();
  const relationships: UpgradeRelationship[] = [];
  for (const file of files) {
    const parsed = parseForkcastEip(await readFile(path.join(dir, file), 'utf8'), file);
    const id = Number(file.slice(0, -'.json'.length));
    if (seenIds.has(id)) throw new Error(`Forkcast: duplicate EIP record ${id}`);
    seenIds.add(id);
    relationships.push(...parsed);
  }
  return relationships;
}

export function bpoRelationships(
  metas: BpoMetaUpgrade[],
  merged: Map<number, Proposal>,
): UpgradeRelationship[] {
  const relationships: UpgradeRelationship[] = [];
  const seenNames = new Set<string>();
  for (const meta of metas) {
    if (seenNames.has(meta.name)) throw new Error(`duplicate BPO Meta EIP for ${meta.name}`);
    seenNames.add(meta.name);
    // A draft with placeholders (currently BPO3) is not formally scheduled.
    if (meta.activation === undefined) continue;

    let dependencies = 0;
    for (const required of meta.requires) {
      const proposal = merged.get(required);
      if (!proposal) throw new Error(`EIP-${meta.meta}: required EIP-${required} is missing`);
      if (proposal.ty === 'Meta') continue;
      if (proposal.k !== 'eip') {
        throw new Error(`EIP-${meta.meta}: required ${required} is not an EIP`);
      }
      dependencies++;
      relationships.push({
        proposal: required,
        name: meta.name,
        status: meta.status,
        meta: meta.meta,
        order: meta.activation,
        source: `BPO Meta EIP-${meta.meta}`,
      });
    }
    if (dependencies === 0) {
      throw new Error(`EIP-${meta.meta}: BPO Meta EIP has no non-Meta protocol dependency`);
    }
  }
  return relationships;
}

// -- open pull requests ------------------------------------------------------

/**
 * Enumerating open PRs *with their file lists* needs GraphQL, and GraphQL always
 * needs a token. (REST would take one call per PR across ~755 PRs, which blows
 * the 60/hour anonymous limit.) Everything else in this script is unauthenticated.
 */
async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await exec('gh', ['auth', 'token']);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // gh not installed or not logged in; fall through to the message below.
  }
  throw new Error(
    'A GitHub token is needed to index open pull requests.\n' +
      '  Set GITHUB_TOKEN=<token>, or run `gh auth login`.',
  );
}

async function graphql(token: string, query: string): Promise<any> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

interface PrNode {
  number: number;
  createdAt: string;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  files: { nodes: Array<{ path: string }> | null } | null;
}

async function openPullRequests(token: string, repo: 'EIPs' | 'ERCs'): Promise<PrNode[]> {
  const nodes: PrNode[] = [];
  let cursor: string | null = null;
  for (;;) {
    const after = cursor ? `, after: "${cursor}"` : '';
    // files(first: 50) rather than a smaller page: a proposal PR can carry a
    // dozen asset files alongside the markdown, and the markdown must not fall
    // off the end of the list.
    const data = await graphql(
      token,
      `{ repository(owner: "ethereum", name: "${repo}") {
           pullRequests(states: OPEN, first: 100${after}) {
             pageInfo { hasNextPage endCursor }
             nodes {
               number createdAt headRefOid
               headRepository { nameWithOwner }
               files(first: 50) { nodes { path } }
             }
           }
         } }`,
    );
    const page = data.repository.pullRequests;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return nodes;
}

/** Runs `worker` over `items` with a small concurrency cap. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!);
      }
    }),
  );
  return results;
}

/**
 * Collects proposals that exist only in open pull requests.
 *
 * EIP numbers are assigned while a proposal is still an open PR, and public
 * discussion clusters in that window, so these are often the most-referenced
 * proposals of all.
 */
async function collectOpenPRs(merged: Set<number>): Promise<Proposal[]> {
  const token = await githubToken();

  interface Candidate {
    repo: 'EIPs' | 'ERCs';
    kind: 'eip' | 'erc';
    n: number;
    filePath: string;
    pr: number;
    head: string;
    ref: string;
    opened: string;
  }
  const candidates: Candidate[] = [];
  let skippedPlaceholder = 0;

  for (const repo of ['EIPs', 'ERCs'] as const) {
    const prs = await openPullRequests(token, repo);
    const subdir = repo === 'EIPs' ? 'EIPS' : 'ERCS';
    const kind = repo === 'EIPs' ? ('eip' as const) : ('erc' as const);

    for (const pr of prs) {
      const head = pr.headRepository?.nameWithOwner;
      if (!head) continue;
      for (const file of pr.files?.nodes ?? []) {
        // A numeric filename is the filter that drops every placeholder in the
        // wild -- eip-XXXX.md, eip-aass.md, eip-draft_*.md, erc-persistent-identity.md.
        const m = new RegExp(`^${subdir}/(?:eip|erc)-(\\d+)\\.md$`).exec(file.path);
        if (!m) {
          if (new RegExp(`^${subdir}/(?:eip|erc)-.+\\.md$`).test(file.path)) skippedPlaceholder++;
          continue;
        }
        const n = Number(m[1]);
        // n === 0 is the "assign me a number" placeholder. A number already in
        // master means this is an "Update EIP-X" PR, which is the large majority.
        if (n === 0 || merged.has(n)) continue;
        candidates.push({
          repo,
          kind,
          n,
          filePath: file.path,
          pr: pr.number,
          head,
          ref: pr.headRefOid,
          opened: pr.createdAt,
        });
      }
    }
    log(`    ${repo}: ${prs.length} open PRs`);
  }

  log(`    ${candidates.length} candidate files (skipped ${skippedPlaceholder} placeholder names)`);

  // raw.githubusercontent is a CDN, so these do not consume the API rate limit.
  const fetched = await mapLimit(candidates, 8, async (c) => {
    const url = `https://raw.githubusercontent.com/${c.head}/${c.ref}/${c.filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      log(`    ! HTTP ${res.status} for ${c.filePath} (PR #${c.pr})`);
      return null;
    }
    const fm = parseFrontmatter(await res.text());
    if (!fm) {
      log(`    ! no parseable frontmatter: ${c.filePath} (PR #${c.pr})`);
      return null;
    }
    // The filename and the frontmatter must agree, or we would file the proposal
    // under a number its own document disowns -- a common template copy-paste slip.
    if (Number(fm.eip) !== c.n) {
      log(`    ! ${c.filePath} declares eip: ${str(fm.eip)} (PR #${c.pr}) -- skipped`);
      return null;
    }
    const title = str(fm.title);
    if (!title) {
      log(`    ! missing title: ${c.filePath} (PR #${c.pr})`);
      return null;
    }
    // Open-PR frontmatter is author-written and unreviewed, and the status is its
    // least load-bearing field -- one PR declares `status: New`. Normalise rather
    // than dropping an otherwise real proposal or failing the whole build.
    let status = str(fm.status) || 'Draft';
    if (!KNOWN_STATUSES.has(status)) {
      log(`    ~ ${c.filePath} (PR #${c.pr}) has status ${JSON.stringify(status)} -> Draft`);
      status = 'Draft';
    }

    const proposal: Proposal = {
      n: c.n,
      t: title,
      d: str(fm.description),
      s: status,
      ty: str(fm.type),
      c: str(fm.category),
      k: c.kind,
      disc: str(fm['discussions-to']),
      cr: str(fm.created),
      req: str(fm.requires)
        .split(/[,\s]+/)
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x > 0),
      pr: c.pr,
      prRepo: c.repo,
      prRef: c.ref,
      prHead: c.head,
      prOpened: c.opened,
    };
    return proposal;
  });

  return fetched.filter((p): p is Proposal => p !== null);
}

/**
 * Applies data/aliases.json, so one proposal can resolve under several numbers
 * and be filed under the number an editor actually assigned it.
 *
 * Open-PR targets are keyed by PR number rather than proposal number: "the
 * proposal at 8361" is ambiguous when two PRs claim it, whereas "the proposal
 * from PR #12081" never is. Merged targets use their canonical proposal number.
 */
async function applyAliases(
  merged: Map<number, Proposal>,
  unmerged: Proposal[],
): Promise<string[]> {
  const errors: string[] = [];
  let raw: string;
  try {
    raw = await readFile(path.join(ROOT, 'data', 'aliases.json'), 'utf8');
  } catch {
    log('    no data/aliases.json; skipping');
    return errors;
  }
  const entries = JSON.parse(raw) as AliasEntry[];

  for (const entry of entries) {
    const label = `alias entry ${entry.canonical}`;
    if (!entry.reason?.trim()) {
      errors.push(`${label}: missing "reason" -- an undocumented alias is unauditable`);
      continue;
    }
    if (
      entry.reason !== entry.reason.trim() ||
      entry.reason.includes('\n') ||
      entry.reason.length > 160 ||
      /\b(?:likely|probably|perhaps|maybe|seems?|appears?)\b/i.test(entry.reason)
    ) {
      errors.push(`${label}: "reason" must be one concise factual line (160 characters maximum)`);
      continue;
    }

    const target =
      entry.target.pr !== undefined
        ? unmerged.find((p) => p.pr === entry.target.pr && p.prRepo === entry.target.repo)
        : merged.get(entry.target.n!);
    if (!target) {
      // Loud rather than silent: a stale entry means the PR merged, was closed,
      // or renamed its file, and it needs a human decision.
      errors.push(`${label}: target ${JSON.stringify(entry.target)} not found`);
      continue;
    }

    if (entry.target.pr !== undefined && isStaleOpenAlias(target)) {
      errors.push(
        `${label}: target ${JSON.stringify(entry.target)} has been open for at least ` +
          `${DEFAULT_STALE_ALIAS_DAYS} days; retire the alias`,
      );
      continue;
    }

    // Two proposals both claiming to canonically be one number is a genuine
    // conflict a human has to resolve.
    const canonicalOwner = [...merged.values(), ...unmerged].find(
      (p) => p !== target && p.n === entry.canonical,
    );
    if (canonicalOwner) {
      errors.push(
        `${label}: ${entry.canonical} is already the number of ` +
          `${JSON.stringify(canonicalOwner.t)} -- resolve by hand`,
      );
      continue;
    }

    // Keep the filename number so the source link keeps resolving; the file is
    // often still named after the number the author originally self-assigned.
    if (target.n !== entry.canonical) target.prFileN = target.n;
    target.n = entry.canonical;
    target.aka = [...new Set(entry.alsoKnownAs)].filter((n) => n !== target.n).sort((a, b) => a - b);

    // An alias overlapping another proposal's number is expected, not an error:
    // that is exactly the contested case the tooltip is designed to show.
    for (const n of target.aka) {
      const other = [...merged.values(), ...unmerged].find((p) => p !== target && p.n === n);
      if (other) log(`    note: ${n} is also claimed by ${JSON.stringify(other.t)}`);
    }
    const kind = target.k.toUpperCase();
    log(
      `    PR #${target.pr ?? '-'} ${JSON.stringify(target.t)} -> ${kind}-${target.n}` +
        `${target.aka.length ? ` (also ${target.aka.join(', ')})` : ''}` +
        `${target.prFileN ? `, file ${target.k}-${target.prFileN}.md` : ''}`,
    );
  }
  return errors;
}

/** Numbers and titles as published on eips.ethereum.org, for cross-checking. */
async function fetchSiteIndex(): Promise<Map<number, string>> {
  const res = await fetch('https://eips.ethereum.org/all');
  if (!res.ok) throw new Error(`site index: HTTP ${res.status}`);
  const html = await res.text();
  const site = new Map<number, string>();

  // Select cells by their semantic class rather than by column position. The
  // column layout varies per status section -- Last Call inserts a "Review
  // ends" column and Withdrawn inserts a "Withdrawn Reason" column -- so
  // positional or shape-guessing parsers silently read the wrong field.
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    if (!row) continue;
    const num = /<td[^>]*class="[^"]*\beipnum\b[^"]*"[^>]*>[\s\S]*?\/EIPS\/eip-(\d+)/.exec(row);
    if (!num) continue;
    const title = /<td[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(row);
    if (!title) {
      throw new Error(`site row for eip-${num[1]} has no .title cell -- markup changed`);
    }
    site.set(Number(num[1]), stripHtml(title[1]!));
  }
  return site;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    // Ampersand last, so an escaped entity does not get decoded twice.
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ');
}

/**
 * Cross-checks the *merged* tier against the published site and fails the build on
 * any disagreement. This is what stops an upstream schema or layout change from
 * silently shipping a broken or empty dataset.
 *
 * Scoped to merged proposals deliberately: open-PR proposals appear nowhere on
 * the site, so they are unverifiable this way and get schema checks instead.
 */
function validate(proposals: Map<number, Proposal>, site: Map<number, string>): string[] {
  const errors: string[] = [];
  const ours = new Set(proposals.keys());
  const theirs = new Set(site.keys());

  const missing = [...theirs].filter((n) => !ours.has(n)).sort((a, b) => a - b);
  const extra = [...ours].filter((n) => !theirs.has(n)).sort((a, b) => a - b);
  if (missing.length) errors.push(`on site but not parsed: ${missing.join(', ')}`);
  if (extra.length) errors.push(`parsed but not on site: ${extra.join(', ')}`);

  const mismatched: string[] = [];
  for (const [n, siteTitle] of site) {
    const ourTitle = proposals.get(n)?.t;
    if (ourTitle && stripHtml(ourTitle) !== siteTitle) {
      mismatched.push(`  eip-${n}: parsed ${JSON.stringify(ourTitle)} vs site ${JSON.stringify(siteTitle)}`);
    }
  }
  if (mismatched.length) {
    errors.push(`${mismatched.length} title mismatch(es):\n${mismatched.slice(0, 15).join('\n')}`);
  }

  // Regression guard for the YAML-quoting bug: a title must never retain the
  // quote characters that YAML used to escape an embedded colon.
  const quoted = [...proposals.values()].filter((p) => /^["']|["']$/.test(p.t));
  if (quoted.length) {
    errors.push(`titles with leftover quotes: ${quoted.map((p) => `eip-${p.n}`).join(', ')}`);
  }

  if (proposals.size < 1000) {
    errors.push(`implausibly few proposals: ${proposals.size}`);
  }
  return errors;
}

/**
 * Schema-only checks for the open-PR tier. There is nothing authoritative to
 * compare these against, so the checks assert internal consistency and a
 * plausible count -- enough that a GraphQL shape change fails loudly rather than
 * silently shipping zero unmerged proposals.
 */
function validateUnmerged(unmerged: Proposal[], merged: Map<number, Proposal>): string[] {
  const errors: string[] = [];

  for (const p of unmerged) {
    const at = `pr #${p.pr} (eip-${p.n})`;
    if (!p.pr || !p.prRepo || !p.prRef || !p.prOpened) {
      errors.push(`${at}: incomplete PR provenance`);
    }
    if (p.prOpened && !Number.isFinite(Date.parse(p.prOpened))) {
      errors.push(`${at}: invalid PR creation time ${JSON.stringify(p.prOpened)}`);
    }
    if (!p.t) errors.push(`${at}: missing title`);
    // Everything real is 4 digits by now; a low number here means a placeholder
    // or a misparse rather than a genuine proposal.
    if (p.n < 1000) errors.push(`${at}: implausibly low number`);
    if (p.s && !KNOWN_STATUSES.has(p.s)) errors.push(`${at}: unknown status ${JSON.stringify(p.s)}`);
    if (merged.has(p.n)) errors.push(`${at}: collides with a merged proposal`);
    if (/^["']|["']$/.test(p.t)) errors.push(`${at}: title has leftover quotes`);
  }

  if (unmerged.length < 20 || unmerged.length > 600) {
    errors.push(`implausible open-PR count: ${unmerged.length} (expected 20-600)`);
  }
  return errors;
}

function fail(errors: string[]): never {
  process.stderr.write(`\nVALIDATION FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

/** Every number a proposal answers to: its own, plus any curated aliases. */
function numbersOf(p: Proposal): number[] {
  return [p.n, ...(p.aka ?? [])];
}

/**
 * Deduplicates upstream relationships. A scheduled relationship may coexist
 * with an EELS activation for the same fork while sources catch up; activation
 * wins. Every other duplicate is an upstream-data error.
 */
export function mergeUpgradeRelationships(
  relationships: UpgradeRelationship[],
): UpgradeRelationship[] {
  const merged = new Map<string, UpgradeRelationship>();
  for (const relationship of relationships) {
    const key = `${relationship.proposal}\u0000${relationship.name}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, relationship);
      continue;
    }
    if (existing.status !== relationship.status) {
      const included = existing.status === 'included' ? existing : relationship;
      const scheduled = existing.status === 'scheduled' ? existing : relationship;
      if (included.source === 'EELS' && scheduled.status === 'scheduled') {
        merged.set(key, included);
        continue;
      }
    }
    throw new Error(
      `duplicate upgrade relationship EIP-${relationship.proposal} / ${relationship.name} ` +
        `(${existing.source}, ${relationship.source})`,
    );
  }
  return [...merged.values()];
}

/** Resolves and attaches relationships, returning missing/ambiguous references. */
export function attachUpgradeRelationships(
  proposals: Proposal[],
  relationships: UpgradeRelationship[],
): string[] {
  const errors: string[] = [];
  const assignments: Array<{ proposal: Proposal; relationship: UpgradeRelationship }> = [];

  for (const relationship of mergeUpgradeRelationships(relationships)) {
    const metaMatches = proposals.filter(
      (proposal) => proposal.k === 'eip' && proposal.n === relationship.meta,
    );
    if (metaMatches.length === 0) {
      errors.push(
        `${relationship.source}: Meta EIP-${relationship.meta} for ${relationship.name} is missing`,
      );
    } else if (metaMatches.length > 1) {
      errors.push(
        `${relationship.source}: Meta EIP-${relationship.meta} for ${relationship.name} is ambiguous`,
      );
    } else if (metaMatches[0]!.ty !== 'Meta' || metaMatches[0]!.pr !== undefined) {
      errors.push(
        `${relationship.source}: Meta EIP-${relationship.meta} for ${relationship.name} must be a merged Meta EIP`,
      );
    }

    // Upgrade sources describe EIPs. ERCs never inherit membership through
    // `requires`, even when an ERC and EIP happen to share a number.
    const matches = proposals.filter(
      (proposal) => proposal.k === 'eip' && proposal.n === relationship.proposal,
    );
    if (matches.length === 0) {
      errors.push(
        `${relationship.source}: EIP-${relationship.proposal} referenced by ${relationship.name} is missing`,
      );
    } else if (matches.length > 1) {
      errors.push(
        `${relationship.source}: EIP-${relationship.proposal} referenced by ${relationship.name} is ambiguous`,
      );
    } else {
      assignments.push({ proposal: matches[0]!, relationship });
    }
  }

  if (errors.length) return errors;
  const byProposal = new Map<Proposal, UpgradeRelationship[]>();
  for (const assignment of assignments) {
    const list = byProposal.get(assignment.proposal);
    if (list) list.push(assignment.relationship);
    else byProposal.set(assignment.proposal, [assignment.relationship]);
  }
  for (const [proposal, upgrades] of byProposal) {
    proposal.u = upgrades
      .sort(
        (a, b) =>
          Number(a.status === 'scheduled') - Number(b.status === 'scheduled') ||
          a.order - b.order ||
          a.name.localeCompare(b.name),
      )
      .map(({ name: n, status: s, meta: m }) => ({ n, s, m }));
  }
  return errors;
}

/**
 * An alias targeting an open pull request expires at the configured boundary.
 */
export function isStaleOpenAlias(
  proposal: Pick<Proposal, 'pr' | 'prOpened'>,
  now = Date.now(),
  thresholdDays = DEFAULT_STALE_ALIAS_DAYS,
): boolean {
  if (!proposal.pr || !proposal.prOpened) return false;
  const opened = Date.parse(proposal.prOpened);
  return Number.isFinite(opened) && now - opened >= thresholdDays * DAY_MS;
}

/**
 * Constructs the exact compact bytes in memory and emits only the tiny constants
 * consumed by the bundled fallback. `--database-only` intentionally reads the
 * already-generated committed data and performs no upstream collection.
 */
async function writeDatabaseConstants(
  proposals: Proposal[],
  mergedNumbers: number[],
  unmergedNumbers: number[],
): Promise<{ databaseVersion: number; payloadSha256: string }> {
  const database = await constructDatabaseFromSources(proposals, mergedNumbers, unmergedNumbers);
  await writeFile(
    OUT_DATABASE_GENERATED,
    `// Generated by scripts/build-dataset.ts -- do not edit.\n` +
      `/** Monotonic YYYYMMDDNN version of the bundled fallback database. */\n` +
      `export const BUNDLED_DATABASE_VERSION = ${database.payload.databaseVersion};\n` +
      `/** SHA-256 of the exact compact payload reconstructed from committed sources. */\n` +
      `export const BUNDLED_DATABASE_PAYLOAD_SHA256 = '${database.payloadSha256}';\n`,
  );
  return {
    databaseVersion: database.payload.databaseVersion,
    payloadSha256: database.payloadSha256,
  };
}

async function buildDatabaseFromCommittedData(): Promise<void> {
  log('Building signed-database constants from committed generated data (no network)');
  const database = await reconstructCommittedDatabase();
  await writeFile(
    OUT_DATABASE_GENERATED,
    `// Generated by scripts/build-dataset.ts -- do not edit.\n` +
      `/** Monotonic YYYYMMDDNN version of the bundled fallback database. */\n` +
      `export const BUNDLED_DATABASE_VERSION = ${database.payload.databaseVersion};\n` +
      `/** SHA-256 of the exact compact payload reconstructed from committed sources. */\n` +
      `export const BUNDLED_DATABASE_PAYLOAD_SHA256 = '${database.payloadSha256}';\n`,
  );
  log(
    `  reconstructed compact database v${database.payload.databaseVersion} and wrote generated digest ` +
      `${database.payloadSha256.slice(0, 12)}…`,
  );
}

async function main() {
  log('Building EIP/ERC dataset');
  const merged = await collect();
  const bpoMetas = await collectBpoMetas();

  log('  validating merged tier against eips.ethereum.org/all...');
  const site = await fetchSiteIndex();
  log(`    site lists ${site.size} proposals; parsed ${merged.size}`);
  const mergedErrors = validate(merged, site);
  if (mergedErrors.length) fail(mergedErrors);
  log('    ok: sets match, titles match, no leftover quotes');

  log('  indexing open pull requests...');
  const unmerged = await collectOpenPRs(new Set(merged.keys()));
  log(`    ${unmerged.length} proposals live only in open PRs`);
  const unmergedErrors = validateUnmerged(unmerged, merged);
  if (unmergedErrors.length) fail(unmergedErrors);

  log('  applying data/aliases.json...');
  const aliasErrors = await applyAliases(merged, unmerged);
  if (aliasErrors.length) fail(aliasErrors);

  log('  indexing mainnet upgrade membership...');
  const [eelsRelationships, forkcastRelationships] = await Promise.all([
    fetchEelsRelationships(),
    collectForkcastRelationships(),
  ]);
  const bpo = bpoRelationships(bpoMetas, merged);
  const upgradeErrors = attachUpgradeRelationships(
    [...merged.values(), ...unmerged],
    [...eelsRelationships, ...forkcastRelationships, ...bpo],
  );
  if (upgradeErrors.length) fail(upgradeErrors);
  log(
    `    ${eelsRelationships.length} EELS + ${forkcastRelationships.length} scheduled + ` +
      `${bpo.length} BPO relationships`,
  );

  // Within one number, merged first, then earliest PR first -- see the plan's
  // note on why not by last-updated.
  const sorted = [...merged.values(), ...unmerged].sort(
    (a, b) =>
      a.n - b.n ||
      Number(Boolean(a.pr)) - Number(Boolean(b.pr)) ||
      (a.prOpened ?? '').localeCompare(b.prOpened ?? ''),
  );

  // Number-only indexes, inlined into the content script so that pages with no
  // EIP references never pull in the full metadata payload. Split by tier so the
  // "include open PRs" setting costs nothing at match time.
  const mergedNums = [...new Set([...merged.values()].flatMap(numbersOf))].sort((a, b) => a - b);
  const unmergedNums = [...new Set(unmerged.flatMap(numbersOf))]
    .filter((n) => !mergedNums.includes(n))
    .sort((a, b) => a - b);

  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  // Keep committed source data reviewable. The background constructs and Vite
  // minifies the validated runtime payload, so source whitespace is not shipped.
  await writeFile(OUT_JSON, `${JSON.stringify(sorted, null, 2)}\n`);

  await writeFile(
    OUT_NUMBERS,
    `// Generated by scripts/build-dataset.ts -- do not edit.\n` +
      `// Valid proposal numbers only, kept apart from the metadata so the content\n` +
      `// script can reject candidate matches without loading it. Both lists\n` +
      `// include curated aliases from data/aliases.json.\n\n` +
      `/** Proposals merged into master. */\n` +
      `export const VALID_NUMBERS: readonly number[] = [\n${chunk(mergedNums)}\n];\n\n` +
      `/** Proposals that so far exist only in an open pull request. */\n` +
      `export const UNMERGED_NUMBERS: readonly number[] = [\n${chunk(unmergedNums)}\n];\n`,
  );
  // Construct the exact compact signed bytes in memory and emit their digest.
  // Signing remains a separate offline step, so refreshes need no private key.
  // Runtime clients consume these arrays; they never infer indexes from records.
  const database = await writeDatabaseConstants(sorted, mergedNums, unmergedNums);

  // Report the compact payload size, which is the form embedded by WXT/Vite.
  const bytes = Buffer.byteLength(JSON.stringify(sorted));
  const aliased = sorted.filter((p) => p.aka?.length);
  log(
    `  wrote data/eips.json (${merged.size} merged + ${unmerged.length} open-PR ` +
      `= ${sorted.length}, ${(bytes / 1024).toFixed(1)} KB minified payload)`,
  );
  log(`  wrote src/core/numbers.generated.ts (${mergedNums.length} + ${unmergedNums.length} numbers)`);
  log(
    `  reconstructed compact database v${database.databaseVersion} and wrote generated digest ` +
      `${database.payloadSha256.slice(0, 12)}…`,
  );
  if (aliased.length) log(`  ${aliased.length} proposal(s) carry aliases`);
  await rm(CACHE, { recursive: true, force: true });

  reportContested(sorted, new Set(aliased.map((p) => p.pr!).filter(Boolean)));
}

/**
 * Numbers claimed by more than one open PR, printed for a human to look at.
 *
 * A contested number is a number one side will lose, so it is the cheapest
 * warning that a renumbering is coming: both renumberings found so far -- 8361 to
 * 8363, and 8338 to 8351 -- were contested first. It cannot say what the new
 * number will be; `npm run data:review` asks the forum that.
 */
export function reportContested(all: Proposal[], aliased: Set<number>) {
  const byNumber = new Map<number, Proposal[]>();
  for (const p of all) {
    if (!p.pr) continue;
    const list = byNumber.get(p.n);
    if (list) list.push(p);
    else byNumber.set(p.n, [p]);
  }
  const contested = [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => a[0] - b[0]);
  if (contested.length === 0) {
    log('');
    log('REVIEW: 0 numbers claimed by more than one open PR. Nothing to resolve.');
    return;
  }

  log('');
  log(`REVIEW: ${contested.length} number(s) claimed by more than one open PR.`);
  log('  One claimant will be renumbered. Run `npm run data:review` to ask the');
  log('  forum which, then add an entry to data/aliases.json.');
  for (const [n, list] of contested) {
    const covered = list.some((p) => aliased.has(p.pr!)) ? '  [alias present]' : '';
    log(`  ${n}${covered}`);
    for (const p of list) log(`      PR #${p.pr} ${p.prRepo}  ${JSON.stringify(p.t)}`);
  }
}

function chunk(nums: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < nums.length; i += 20) {
    lines.push(`  ${nums.slice(i, i + 20).join(', ')},`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const command =
    args.length === 0
      ? main()
      : args.length === 1 && args[0] === '--database-only'
        ? buildDatabaseFromCommittedData()
        : Promise.reject(new Error('Usage: npm run data:build [-- --database-only]'));
  command.catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
