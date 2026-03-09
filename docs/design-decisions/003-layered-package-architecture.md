# ADR-003: Strict Layered Package Dependency Direction

**Status**: Accepted

## Context

Monorepo with 5 packages needs clear dependency rules. Without them, circular dependencies emerge and packages become tightly coupled.

## Decision

Packages form a strict linear dependency chain. Each package may only depend on packages to its left:

```
protocol → session → llm → agent → openomni → cli
```

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `protocol`
- `llm`: `protocol`, `session`
- `agent`: `protocol`, `llm`
- `openomni`: any `@openomni/*`
- `cli`: any `@openomni/*`

Reverse dependencies (e.g., `protocol` importing from `session`) are build failures. Cross-package imports go through `index.ts` barrel only — no deep imports like `@openomni/llm/src/auth/storage`.

## Rationale

- **Prevents circular deps**: Linear chain makes cycles structurally impossible.
- **Independent testability**: Lower packages (`protocol`, `session`) can be tested without upper packages.
- **Clear ownership**: Each layer has a defined responsibility boundary.
- **Enforceable**: `script/check-deps.ts` validates both dependency direction and package boundary violations in CI.

## Consequences

- Adding a new package requires deciding its position in the chain.
- Shared types must live in `protocol` (the leaf), even if only used by 2 packages.
- Known tech debt: `apps/cli` has 2 deep import violations (`@openomni/llm/src/auth/`) — tracked, not extended.
- `agent` package has a vestigial `@openomni/session` dependency in `package.json` (0 actual imports) — to be cleaned up.
