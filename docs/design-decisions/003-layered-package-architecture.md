# ADR-003: Strict Layered Package Dependency Direction

**Status**: Accepted

## Context

Monorepo with 6 packages and 2 apps needs clear dependency rules. Without them, circular dependencies emerge and packages become tightly coupled.

## Decision

Packages form a strict linear dependency chain. Apps (`cli`, `server`) are siblings consuming any package. Each package may only depend on packages to its left:

```
protocol → session → llm → agent → openomni → coordinator → { cli, server }
```

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `protocol`
- `llm`: `protocol`, `session`
- `agent`: `protocol`, `llm` — **no session dependency** (enforced; `BusTransport` lives in `openomni`)
- `openomni`: `protocol`, `session`, `llm`, `agent`
- `coordinator`: all packages above — owns worker pool, IPC, recovery, credentials, tool-permission
- `cli`, `server`: any `@openomni/*`; they do not depend on each other

Reverse dependencies (e.g., `protocol` importing from `session`) are build failures. Cross-package imports go through `index.ts` barrel only — no deep imports like `@openomni/llm/src/auth/storage`.

`apps/server` additionally follows a self-imposed rule: it must not import directly from `@openomni/agent`. All agent work flows through `@openomni/openomni`'s `IngressEngine`.

## Rationale

- **Prevents circular deps**: Linear chain makes cycles structurally impossible.
- **Independent testability**: Lower packages (`protocol`, `session`) can be tested without upper packages.
- **Clear ownership**: Each layer has a defined responsibility boundary.
- **Enforceable**: `script/check-deps.ts` validates both dependency direction and package boundary violations in CI.

## Consequences

- Adding a new package requires deciding its position in the chain.
- Shared types must live in `protocol` (the leaf), even if only used by 2 packages.
- `apps/cli` and `apps/server` share nothing at runtime; shared helpers (if any are extracted later) must live in a package, not in either app.
