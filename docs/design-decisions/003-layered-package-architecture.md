# ADR-003: Strict Layered Package Dependency Direction

**Status**: Accepted

## Context

Monorepo with 6 packages and one runtime app needs clear dependency rules. Without them, circular dependencies emerge and packages become tightly coupled.

## Decision

Packages form a strict linear dependency chain. The server app consumes packages at the top of the chain. Each package may only depend on packages to its left:

```
protocol → session → llm → agent → openomni → coordinator → server
```

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `protocol`
- `llm`: `protocol`, `session`
- `agent`: `protocol`, `llm`, and sanctioned `session` observability primitives — **no session state ownership** (session-backed orchestration and `BusTransport` live in `openomni`)
- `openomni`: `protocol`, `session`, `llm`, `agent`
- `coordinator`: all packages above — owns on-demand worker lifecycle, IPC, recovery, credentials, tool-permission
- `server`: any `@openomni/*`; hosts the runtime and external surfaces

Reverse dependencies (e.g., `protocol` importing from `session`) are build failures. Cross-package imports go through `index.ts` barrel only — no deep imports like `@openomni/llm/src/auth/storage`.

`apps/server` additionally follows a self-imposed rule: it must not import directly from `@openomni/agent`. All agent work flows through `@openomni/openomni`'s `IngressEngine`.

## Rationale

- **Prevents circular deps**: Linear chain makes cycles structurally impossible.
- **Independent testability**: Lower packages (`protocol`, `session`) can be tested without upper packages.
- **Clear ownership**: Each layer has a defined responsibility boundary. `agent` may emit observability but must not own durable session state.
- **Enforceable**: `script/check-deps.ts` validates both dependency direction and package boundary violations in CI.

## Consequences

- Adding a new package requires deciding its position in the chain.
- Shared types must live in `protocol` (the leaf), even if only used by 2 packages.
- App-local helpers must not become hidden shared contracts; shared helpers must live in a package.
