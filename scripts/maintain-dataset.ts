import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');

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
`.trim();

export function buildCodexArgs(root = ROOT): string[] {
  return [
    'exec',
    '--model',
    'gpt-5.6-sol',
    '--approve-for-me',
    '--config',
    'sandbox_workspace_write.network_access=true',
    '--config',
    'model_reasoning_effort="high"',
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

export async function runDatasetMaintenance({
  spawnImpl = spawn as SpawnCodex,
  root = ROOT,
}: {
  spawnImpl?: SpawnCodex;
  root?: string;
} = {}): Promise<number> {
  const child = spawnImpl('codex', buildCodexArgs(root), {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
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
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Codex exited after receiving ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
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
