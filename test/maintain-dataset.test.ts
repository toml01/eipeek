import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexArgs,
  DATASET_MAINTENANCE_PROMPT,
  runDatasetMaintenance,
} from '../scripts/maintain-dataset.ts';

describe('dataset maintenance agent launcher', () => {
  it('launches a strong Codex agent with auto-reviewed workspace writes and network access', () => {
    const args = buildCodexArgs('/repo');

    expect(args).toEqual([
      'exec',
      '--model',
      'gpt-5.6-sol',
      '--approve-for-me',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'model_reasoning_effort="high"',
      '--cd',
      '/repo',
      DATASET_MAINTENANCE_PROMPT,
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('never combines the mutually exclusive sandbox and auto-approval flags', () => {
    const args = buildCodexArgs('/repo');

    expect(args).toContain('--approve-for-me');
    expect(args).not.toContain('--sandbox');
  });

  it('gives the agent the complete supervision and safety boundaries', () => {
    expect(DATASET_MAINTENANCE_PROMPT).toContain('$maintain-eip-data');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('npm run data:build');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('npm run data:review');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('direct upstream evidence');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('concise,\ncold facts');
    expect(DATASET_MAINTENANCE_PROMPT).toContain('Do not commit or push');
  });

  it('inherits the personal Codex login without invoking a shell', async () => {
    const child = new EventEmitter();
    const spawnImpl = vi.fn(() => child);
    const result = runDatasetMaintenance({ spawnImpl, root: '/repo' });

    child.emit('exit', 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'codex',
      buildCodexArgs('/repo'),
      expect.objectContaining({
        cwd: '/repo',
        env: process.env,
        shell: false,
        stdio: 'inherit',
      }),
    );
  });
});
