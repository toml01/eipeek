import { describe, expect, it } from 'vitest';
import { FEEDBACK_ISSUE_URL } from '../src/core/feedback';

describe('feedback issue link', () => {
  it('opens the repository-owned feedback issue form', () => {
    const url = new URL(FEEDBACK_ISSUE_URL);

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/toml01/eipeek/issues/new');
    expect(url.searchParams.get('template')).toBe('feedback.yml');
  });
});
