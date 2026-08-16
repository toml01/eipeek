import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexArgs,
  DATASET_MAINTENANCE_PROMPT,
  getRunLogPath,
  runDatasetMaintenance,
} from '../scripts/maintain-dataset.ts';

describe('dataset maintenance agent launcher', () => {
  it('launches a strong Codex agent with auto-reviewed workspace writes, network access, and final-message capture', () => {
    const args = buildCodexArgs('/repo', '/tmp/final-message.txt');

    expect(args).toEqual([
      'exec',
      '--model',
      'gpt-5.6-sol',
      '--approve-for-me',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'model_reasoning_effort="high"',
      '--output-last-message',
      '/tmp/final-message.txt',
      '--cd',
      '/repo',
      DATASET_MAINTENANCE_PROMPT,
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('never combines the mutually exclusive sandbox and auto-approval flags', () => {
    const args = buildCodexArgs('/repo', '/tmp/final-message.txt');

    expect(args).toContain('--approve-for-me');
    expect(args).not.toContain('--sandbox');
  });

  it('gives the agent the complete supervision, logging, and safety boundaries', () => {
    expect(DATASET_MAINTENANCE_PROMPT).toContain('$maintain-eip-data');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('npm run data:build');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('npm run data:review');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('direct upstream evidence');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('concise,\ncold facts');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('Do not commit or push');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('Summary:');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('Problems:');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('Recommendations:');
    expect(DATASET_MAINTENANCE_PROMPT).toContain(
      'improvements or changes to the scripts or maintenance workflow',
    );
  });

  it('inherits the personal Codex login while keeping terminal output live', async () => {
    const root = await makeTemporaryRoot();
    try {
      const child = new EventEmitter();
      const spawnImpl = vi.fn(() => child);
      const result = runDatasetMaintenance({ spawnImpl, root });

      child.emit('exit', 0, null);

      await expect(result).resolves.toBe(0);
      expect(spawnImpl).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining([
          'exec',
          '--output-last-message',
          expect.any(String),
          '--cd',
          root,
        ]),
        expect.objectContaining({
          cwd: root,
          env: process.env,
          shell: false,
          stdio: 'inherit',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('appends a structured report for every run instead of overwriting earlier entries', async () => {
    const root = await makeTemporaryRoot();
    try {
      await runDatasetMaintenance({
        root,
        spawnImpl: successfulSpawn('Summary:\nFirst refresh.\n\nProblems:\nNone.\n\nRecommendations:\nNone.'),
      });
      await runDatasetMaintenance({
        root,
        spawnImpl: successfulSpawn('Summary:\nSecond refresh.\n\nProblems:\nNone.\n\nRecommendations:\nCheck aliases monthly.'),
      });

      const log = await readFile(getRunLogPath(root), 'utf8');
      expect(log.match(/^## Dataset maintenance run$/gm)).toHaveLength(2);
      expect(log).toContain('First refresh.');
      expect(log).toContain('Second refresh.');
      expect(log).toContain('Outcome: success (exit code 0)');
      expect(log).toContain('Check aliases monthly.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('logs useful fallbacks when Codex fails without a final summary', async () => {
    const root = await makeTemporaryRoot();
    try {
      const result = await runDatasetMaintenance({ root, spawnImpl: failingSpawn(2) });

      expect(result).toBe(2);
      const log = await readFile(getRunLogPath(root), 'utf8');
      expect(log).toContain('Outcome: failed (exit code 2)');
      expect(log).toContain('No final agent summary was produced.');
      expect(log).toContain('Codex exited with code 2.');
      expect(log).toContain('Review the live terminal output, resolve the failure, then rerun data:maintain.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('appends a fallback record when Codex cannot be started', async () => {
    const root = await makeTemporaryRoot();
    try {
      const child = new EventEmitter();
      const spawnImpl = vi.fn(() => child);
      const result = runDatasetMaintenance({ root, spawnImpl });
      child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));

      await expect(result).rejects.toThrow('Codex CLI is not installed');
      const log = await readFile(getRunLogPath(root), 'utf8');
      expect(log).toContain('Outcome: failed to start or complete');
      expect(log).toContain('No final agent summary was produced.');
      expect(log).toContain('Codex could not start or complete: Codex CLI is not installed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeTemporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'eipeek-maintenance-test-'));
}

function successfulSpawn(summary: string) {
  return vi.fn((_: string, args: readonly string[]) => {
    const child = new EventEmitter();
    const outputPath = args[args.indexOf('--output-last-message') + 1];
    if (!outputPath) {
      throw new Error('Expected an output-last-message path.');
    }
    void writeFile(outputPath, summary, 'utf8').then(() => child.emit('exit', 0, null));
    return child;
  });
}

function failingSpawn(code: number) {
  return vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', code, null));
    return child;
  });
}
