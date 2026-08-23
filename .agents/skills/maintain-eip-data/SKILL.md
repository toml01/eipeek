---
name: maintain-eip-data
description: Supervise this repository's local EIP/ERC and mainnet-upgrade dataset refresh and review workflow. Use when Codex must run npm run data:build or npm run data:review, resolve stale or contested proposal aliases from upstream evidence, review new fork relationships, regenerate proposal data, or validate the resulting local data changes.
---

# Maintain EIP Data

Run and supervise the repository's existing commands in the current checkout through the user's interactive Codex session. Keep deterministic collection and validation in the repository scripts; do not replace their logic with ad hoc code. Do not add CI, hosted automation, schedules, OpenAI API calls, or API-key requirements.

## Guardrails

- Start with `git status --short`. Preserve pre-existing work and distinguish it from this run.
- Treat `data/eips.json` and `src/core/numbers.generated.ts` as generated. Edit only the curated `data/aliases.json`, then regenerate.
- Keep the user informed while long-running commands execute.
- Do not change the data tooling to bypass an upstream or validation failure unless the user separately asks for a tooling change.
- Never commit or push unless the user explicitly asks.

## Refresh and review

1. Run `npm run data:build` from the repository root and retain its complete output, including the final `REVIEW` block. The command validates merged proposals against the published index and checks open-PR and alias consistency.
2. Classify failures before acting:
   - Treat HTTP 429, explicit rate limits, HTTP 408/425/5xx, DNS/TLS failures, connection resets, and timeouts as transient.
   - Treat missing authentication or dependencies and non-rate-limit HTTP 401/403 responses as setup failures; report the needed remedy instead of retrying unchanged.
   - Treat alias-target, schema, parser, upstream-data, and validation errors as deterministic; investigate them instead of retrying unchanged.
   - For upgrade failures, compare the exact EELS mainnet row, Forkcast relationship history, or BPO Meta EIP. A new scheduled fork name requires evidence for its common display name and roadmap position before updating the explicit normalization/order tables. Do not infer membership from ERCs, aliases, or transitive `requires`.
3. Retry a transient command at most twice, waiting 15 seconds and then 60 seconds. Honor `Retry-After` or a published reset time only when it is no more than 120 seconds; otherwise stop and report the reset time. Never reinterpret an exhausted or partial request as success.
4. Retire every alias targeting an open PR at least 180 days after its `prOpened` timestamp. This is a deterministic expiry rule; do not retain it based on further evidence. Audit every younger alias for continued usefulness, plus every contested number, using direct upstream evidence: the exact EIPs/ERCs pull requests, editor allocation comments, merged files or commits, current frontmatter, and the Magicians thread redirect when available. Treat the forum as advisory. Do not decide from CI state, draft state, title similarity, or PR ordering alone.
5. For aliases below that age, use evidence to decide whether they remain useful. Migrate targets that merged; retire aliases for stagnant, closed, merged, obsolete, or otherwise no-longer-useful proposals only when direct upstream evidence supports that decision.
6. When a still-useful alias merges, migrate its open target from `{ "pr": ..., "repo": ... }` to `{ "n": <merged proposal number> }`; preserve the canonical and historical numbers supported by the evidence. Do not retain an alias solely because it merged, and do not silently delete, merge, or retarget an ambiguous proposal.
7. For a confirmed open-PR renumbering, target the exact PR and repository. Confirm that the canonical number is unclaimed in the refreshed data before adding the alias. Keep all rival claimants to a contested number.
8. Write a short, cold, factual `reason`, such as `"Editors assigned ERC-8351; PR #1913 still uses erc-8338.md."` Avoid speculation, persuasion, and process narration.
9. Run `npm run data:review` against the refreshed dataset. Inspect its text even when it exits zero: disagreements require evidence review, and `COULD NOT BE CHECKED` or `review failed` means the review is incomplete. Apply the same bounded transient retry policy. The review caches forum-confirmed matches in `.cache/review-forum.json` for 24 hours, so a retry after rate limiting resumes with only the unfinished entries; run `npm run data:review -- --no-cache` for a full re-check.
10. Inspect the generated upgrade spot checks and the relationship counts printed by `data:build`. Confirm included upgrades precede scheduled ones, declined relationships remain absent, and ERC-4337 has no upgrade metadata.
11. After any alias or upgrade-order edit, rerun `npm run data:build` and repeat evidence review until validation passes or a concrete blocker remains.

## Validate and hand off

Run:

```sh
npm test
npm run compile
npm run build
npm run test:e2e
git diff --check
```

Inspect `git diff -- data/aliases.json data/eips.json src/core/numbers.generated.ts` and the final `git status --short`. Leave a small, reviewable working-tree diff. Report changed paths, command results, evidence-backed alias decisions, and any incomplete upstream checks; do not commit or push.
