import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const RUN_LOG_FILENAME = 'data-maintenance.log';

export const DATASET_MAINTENANCE_PROMPT = `
Use the $maintain-eip-data skill to supervise this repository's local EIP/ERC
dataset maintenance from start to finish. Run and review npm run data:build and
npm run data:review, then run the validation commands required by the skill.

Keep deterministic work in the repository scripts. Investigate failures and
adapt to transient rate limits, authentication or setup failures, and
deterministic validation conflicts according to their actual cause. Resolve
aliases only from direct upstream evidence. Write alias reasons as concise,
cold facts without speculation or persuasion. Preserve unrelated working-tree
changes. Do not commit or push. Finish by reporting changed paths, command
results, evidence-backed alias decisions, and any incomplete checks.

Treat upgrade metadata as part of the same refresh. Review the EELS, Forkcast,
and BPO relationship counts printed by data:build. When a newly scheduled fork
has no known common name or chronological position, verify both from direct
upstream sources before updating the explicit mapping; never infer membership
from an ERC, alias, or transitive requires relationship.

Your final message is appended to a local maintenance log. End with these
concise sections, using "None." where applicable. Recommendations must cover
any useful improvements or changes to the scripts or maintenance workflow:

Summary:
Problems:
Recommendations:
`.trim();

export function getRunLogPath(root = ROOT): string {
  return path.join(root, RUN_LOG_FILENAME);
}

export function buildCodexArgs(root = ROOT, outputLastMessagePath?: string): string[] {
  const finalMessagePath =
    outputLastMessagePath ??
    path.join(tmpdir(), `eipeek-data-maintenance-${randomUUID()}.txt`);

  return [
    'exec',
    '--model',
    'gpt-5.6-sol',
    '--approve-for-me',
    '--config',
    'sandbox_workspace_write.network_access=true',
    '--config',
    'model_reasoning_effort="high"',
    '--output-last-message',
    finalMessagePath,
    '--cd',
    root,
    DATASET_MAINTENANCE_PROMPT,
  ];
}

interface SpawnedCodex {
  once(event: 'error', listener: (error: Error) => void): SpawnedCodex;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): SpawnedCodex;
}

type SpawnCodex = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedCodex;

interface AgentReport {
  summary: string;
  problems: string;
  recommendations: string;
}

interface RunOutcome {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
}

function cleanSection(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function parseAgentReport(
  message: string | null,
  outcome: RunOutcome,
  readProblem?: string,
): AgentReport {
  const fallbackSummary = 'No final agent summary was produced.';
  const fallbackProblems = outcome.error
    ? `Codex could not start or complete: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
    : outcome.signal
      ? `Codex exited after receiving ${outcome.signal}.`
      : outcome.code && outcome.code !== 0
        ? `Codex exited with code ${outcome.code}.`
        : 'No problems were reported by the agent.';
  const fallbackRecommendations =
    outcome.error || outcome.signal || (outcome.code && outcome.code !== 0)
      ? 'Review the live terminal output, resolve the failure, then rerun data:maintain.'
      : 'No recommendations were provided.';

  if (!message?.trim()) {
    return {
      summary: fallbackSummary,
      problems: readProblem ? `${fallbackProblems} ${readProblem}` : fallbackProblems,
      recommendations: fallbackRecommendations,
    };
  }

  const headings = /^(?:#{1,6}\s*)?(Summary|Problems|Encountered problems|Recommendations)\s*:?\s*(.*)$/gim;
  const sections = new Map<string, string>();
  const matches = [...message.matchAll(headings)];
  for (const [index, match] of matches.entries()) {
    const heading = match[1]!.toLowerCase().replace('encountered ', '');
    const start = (match.index ?? 0) + match[0]!.length;
    const end = matches[index + 1]?.index ?? message.length;
    sections.set(heading, `${match[2] ?? ''}${message.slice(start, end)}`.trim());
  }

  return {
    summary: cleanSection(
      sections.get('summary') ?? (matches.length === 0 ? message : undefined),
      fallbackSummary,
    ),
    problems: cleanSection(
      sections.get('problems'),
      readProblem ? `${fallbackProblems} ${readProblem}` : fallbackProblems,
    ),
    recommendations: cleanSection(sections.get('recommendations'), fallbackRecommendations),
  };
}

export function formatRunLog(
  startedAt: Date,
  finishedAt: Date,
  outcome: RunOutcome,
  report: AgentReport,
): string {
  const outcomeText = outcome.error
    ? `failed to start or complete (${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)})`
    : outcome.signal
      ? `interrupted by ${outcome.signal}`
      : outcome.code === 0
        ? 'success (exit code 0)'
        : `failed (exit code ${outcome.code ?? 1})`;

  return `## Dataset maintenance run\nStarted: ${startedAt.toISOString()}\nFinished: ${finishedAt.toISOString()}\nOutcome: ${outcomeText}\n\nSummary:\n${report.summary}\n\nProblems:\n${report.problems}\n\nRecommendations:\n${report.recommendations}\n\n`;
}

export async function runDatasetMaintenance({
  spawnImpl = spawn as SpawnCodex,
  root = ROOT,
  now = () => new Date(),
}: {
  spawnImpl?: SpawnCodex;
  root?: string;
  now?: () => Date;
} = {}): Promise<number> {
  const startedAt = now();
  const outputLastMessagePath = path.join(
    tmpdir(),
    `eipeek-data-maintenance-${randomUUID()}.txt`,
  );
  let outcome: RunOutcome = {};
  let thrownError: unknown;

  try {
    const child = spawnImpl('codex', buildCodexArgs(root, outputLastMessagePath), {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });

    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              'Codex CLI is not installed or is not on PATH. Install it and run `codex login`, then retry.',
            ),
          );
          return;
        }
        reject(error);
      });
      child.once('exit', (exitCode, signal) => {
        outcome = { code: exitCode, signal };
        resolve(exitCode ?? 1);
      });
    });
    return code;
  } catch (error) {
    outcome = { error };
    thrownError = error;
    throw error;
  } finally {
    let finalMessage: string | null = null;
    let readProblem: string | undefined;
    try {
      finalMessage = await readFile(outputLastMessagePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        readProblem = `Could not read Codex's final message: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    try {
      await appendFile(
        getRunLogPath(root),
        formatRunLog(startedAt, now(), outcome, parseAgentReport(finalMessage, outcome, readProblem)),
        'utf8',
      );
    } catch (error) {
      const loggingError = new Error(
        `Could not append the dataset maintenance log: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!thrownError) {
        throw loggingError;
      }
      process.stderr.write(`${loggingError.message}\n`);
    } finally {
      await rm(outputLastMessagePath, { force: true });
    }
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = await runDatasetMaintenance();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
