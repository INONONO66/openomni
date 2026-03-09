# Quality Score — OpenOmni

> Per-package quality assessment. Updated periodically to track progress.

Last updated: 2026-03-09

| Package  | Tests                  | Types                      | API Stability           | Docs                              | Overall |
| -------- | ---------------------- | -------------------------- | ----------------------- | --------------------------------- | ------- |
| protocol | ⭐⭐⭐ (4 test files)  | ⭐⭐⭐ (strict, no any)    | ⭐⭐⭐ (stable schemas) | ⭐⭐⭐ (AGENTS.md 48L)            | **A-**  |
| session  | ⭐⭐⭐ (10 test files) | ⭐⭐⭐ (strict)            | ⭐⭐⭐ (stable)         | ⭐⭐⭐ (AGENTS.md 47L)            | **A-**  |
| llm      | ⭐⭐⭐ (19 test files) | ⭐⭐ (noEmit)              | ⭐⭐ (evolving)         | ⭐⭐⭐ (AGENTS.md 52L)            | **B+**  |
| agent    | ⭐⭐ (2 test files)    | ⭐⭐⭐ (strict)            | ⭐⭐ (stream() stub)    | ⭐⭐⭐ (AGENTS.md 95L)            | **B**   |
| openomni | ⭐⭐⭐ (67 test files) | ⭐⭐ (legacy has some any) | ⭐⭐ (legacy + new)     | ⭐⭐⭐ (AGENTS.md 72L + docs/) | **B**   |
| cli      | ⭐ (0 test files)      | ⭐⭐ (strict)              | ⭐ (demo/hardcoded)     | ⭐⭐ (AGENTS.md 37L)              | **C**   |

## Rating Criteria

- **Tests**: ⭐ none, ⭐⭐ some coverage, ⭐⭐⭐ comprehensive
- **Types**: ⭐ any/ignore present, ⭐⭐ mostly strict, ⭐⭐⭐ fully strict
- **API Stability**: ⭐ unstable/stub, ⭐⭐ evolving, ⭐⭐⭐ stable
- **Docs**: ⭐ none, ⭐⭐ outdated/oversized, ⭐⭐⭐ concise and current

## Known Tech Debt

- CLI deep imports into `@openomni/llm/src/` internals (2 violations)
- CLI has zero test files
- openomni legacy code has broader `any` usage than other packages
- agent `stream()` is a stub (Phase 2 planned)
- No ESLint configuration across the repo
