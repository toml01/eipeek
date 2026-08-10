import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude git worktrees. A worktree under .claude/ holds a full copy of
    // test/, so vitest collects it too and silently reports several times the
    // real test count -- which hides whether the checked-out tree passes.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '.output/**'],
  },
});
