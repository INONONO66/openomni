# Quality Score — OpenOmni

> Per-package quality assessment. Updated periodically to track progress.

Last updated: 2026-05-01

| Package  | Tests                  | Lint         | Types                      | API Stability           | Docs                           | Overall |
| -------- | ---------------------- | ------------ | -------------------------- | ----------------------- | ------------------------------ | ------- |
| protocol | ⭐⭐⭐ (21 test files) | ⭐⭐ (Biome) | ⭐⭐⭐ (strict, no any)    | ⭐⭐⭐ (stable schemas) | ⭐⭐ (domain list drift noted) | **A-**  |
| session  | ⭐⭐⭐ (24 test files) | ⭐⭐ (Biome) | ⭐⭐⭐ (strict)            | ⭐⭐⭐ (stable)         | ⭐⭐⭐ (AGENTS.md current)     | **A-**  |
| llm      | ⭐⭐⭐ (19 test files) | ⭐⭐ (Biome) | ⭐⭐ (noEmit)              | ⭐⭐ (evolving)         | ⭐⭐⭐ (AGENTS.md 52L)         | **B+**  |
| agent    | ⭐⭐⭐ (41 test files) | ⭐⭐ (Biome) | ⭐⭐ (lint `any` warnings remain) | ⭐⭐ (evolving runtime) | ⭐⭐⭐ (AGENTS.md current) | **B+** |
| openomni | ⭐⭐⭐ (47 test files) | ⭐⭐ (Biome) | ⭐⭐ (active lint debt)    | ⭐⭐ (active orchestration) | ⭐⭐ (docs recently updated) | **B** |
| coordinator | ⭐⭐ (12 test files) | ⭐⭐ (Biome) | ⭐⭐⭐ (strict) | ⭐⭐ (worker runtime evolving) | ⭐⭐ (metrics docs gap) | **B** |
| server   | ⭐⭐ (23 test files) | ⭐⭐ (Biome) | ⭐⭐ (strict)              | ⭐⭐ (runtime host)      | ⭐⭐⭐ (AGENTS.md current)      | **B-**  |

## Rating Criteria

- **Tests**: ⭐ none, ⭐⭐ some coverage, ⭐⭐⭐ comprehensive
- **Types**: ⭐ any/ignore present, ⭐⭐ mostly strict, ⭐⭐⭐ fully strict
- **API Stability**: ⭐ unstable/stub, ⭐⭐ evolving, ⭐⭐⭐ stable
- **Docs**: ⭐ none, ⭐⭐ outdated/oversized, ⭐⭐⭐ concise and current
- **Lint**: ⭐ none, ⭐⭐ Biome configured, ⭐⭐⭐ package-level guardrails fully green
- Coverage reporting: enabled via `bunfig.toml` (`text` + `lcov`), thresholds not enforced yet
- Test counts are file counts from repository discovery. They do not imply coverage percentage or assertion quality.

## Known Tech Debt

- Root/package docs recently drifted around protocol domain counts, LLM paths, and server tool-provider locations; keep AGENTS maps updated with structure changes.
- `apps/cli` has been removed. Auth/config setup now relies on proxy/provider configuration or server/operator flows.
- `apps/server` tests are run directly in CI; keep local test commands aligned with CI when adding app workspaces.
- Some tests still use tautological assertions for no-throw or compile-time checks; convert them to behavioral assertions where possible.
- `packages/openomni/src/execution-runtime/tool/mcp-proxy-provider.ts` is an empty orphan candidate.
- `packages/openomni/src/storage/task-types.ts` is a backward-compat shim still used by a migration script.
- persona workforce runtime contracts are documented but not implemented yet: self-loop kind, inbound authority policy, distilled writeback, persona lifecycle, and memory candidates
- Biome configured (replaces ESLint + Prettier)
