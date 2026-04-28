# Quality Score — OpenOmni

> Per-package quality assessment. Updated periodically to track progress.

Last updated: 2026-04-29

| Package  | Tests                  | Lint         | Types                      | API Stability           | Docs                           | Overall |
| -------- | ---------------------- | ------------ | -------------------------- | ----------------------- | ------------------------------ | ------- |
| protocol | ⭐⭐⭐ (4 test files)  | ⭐⭐ (Biome) | ⭐⭐⭐ (strict, no any)    | ⭐⭐⭐ (stable schemas) | ⭐⭐⭐ (AGENTS.md 48L)         | **A-**  |
| session  | ⭐⭐⭐ (10 test files) | ⭐⭐ (Biome) | ⭐⭐⭐ (strict)            | ⭐⭐⭐ (stable)         | ⭐⭐⭐ (AGENTS.md 47L)         | **A-**  |
| llm      | ⭐⭐⭐ (19 test files) | ⭐⭐ (Biome) | ⭐⭐ (noEmit)              | ⭐⭐ (evolving)         | ⭐⭐⭐ (AGENTS.md 52L)         | **B+**  |
| agent    | ⭐⭐ (2 test files)    | ⭐⭐ (Biome) | ⭐⭐⭐ (strict)            | ⭐⭐ (evolving runtime) | ⭐⭐⭐ (AGENTS.md 95L)         | **B**   |
| openomni | ⭐⭐⭐ (67 test files) | ⭐⭐ (Biome) | ⭐⭐ (some any remain)    | ⭐⭐ (active orchestration) | ⭐⭐⭐ (AGENTS.md + persona docs) | **B**   |
| cli      | ⭐ (0 test files)      | ⭐⭐ (Biome) | ⭐⭐ (strict)              | ⭐ (demo/hardcoded)     | ⭐⭐ (AGENTS.md 37L)           | **C**   |

## Rating Criteria

- **Tests**: ⭐ none, ⭐⭐ some coverage, ⭐⭐⭐ comprehensive
- **Types**: ⭐ any/ignore present, ⭐⭐ mostly strict, ⭐⭐⭐ fully strict
- **API Stability**: ⭐ unstable/stub, ⭐⭐ evolving, ⭐⭐⭐ stable
- **Docs**: ⭐ none, ⭐⭐ outdated/oversized, ⭐⭐⭐ concise and current
- **Lint**: ⭐ none, ⭐⭐ Biome configured, ⭐⭐⭐ package-level guardrails fully green
- Coverage reporting: enabled via `bunfig.toml` (`text` + `lcov`), thresholds not enforced yet

## Known Tech Debt

- CLI deep imports into `@openomni/llm/src/` internals (2 violations)
- CLI has zero test files
- openomni `any` usage reduced after plan mode refactoring (removed legacy plan-json, plan-pipeline, plan-store)
- persona workforce runtime contracts are documented but not implemented yet: self-loop kind, inbound authority policy, distilled writeback, persona lifecycle, and memory candidates
- Biome configured (replaces ESLint + Prettier)
