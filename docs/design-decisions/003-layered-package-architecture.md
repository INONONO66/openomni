# ADR-003: Strict Layered Package Dependency Direction

**Status**: Accepted

## Context

Monorepo with 7 packages and one runtime app needs clear dependency rules. Without them, circular dependencies emerge and packages become tightly coupled.

## Decision

Packages form a strict dependency DAG. The server app consumes packages at the top of the graph. Each package may only depend on lower primitives:

```
protocol → policy → agent → openomni → coordinator → server
protocol → session → llm ────┘
```

- `protocol`: zero `@openomni/*` deps (leaf)
- `policy`: `protocol` only; generic policy dispatch, effect composition, and registry primitives
- `session`: only `protocol`
- `llm`: `protocol`, `session`
- `agent`: `protocol`, `policy`, `llm`, and sanctioned `session` observability primitives — **no session state ownership** (session-backed orchestration and `BusTransport` live in `openomni`)
- `openomni`: `protocol`, `policy`, `session`, `llm`, `agent`
- `coordinator`: all packages above — owns on-demand worker lifecycle, IPC, recovery, credentials, tool-permission
- `server`: any `@openomni/*`; hosts the runtime and external surfaces

Reverse dependencies (e.g., `protocol` importing from `session`) are build failures. Cross-package imports go through `index.ts` barrel only — no deep imports like `@openomni/llm/src/auth/storage`.

`apps/server` additionally follows a self-imposed rule: it must not import directly from `@openomni/agent`. All agent work flows through `@openomni/openomni`'s `IngressEngine`.

## Rationale

- **Prevents circular deps**: The dependency DAG keeps cycles structurally impossible.
- **Independent testability**: Lower packages (`protocol`, `session`) can be tested without upper packages.
- **Clear ownership**: Each layer has a defined responsibility boundary. `agent` may emit observability but must not own durable session state.
- **Enforceable**: `script/check-deps.ts` validates both dependency direction and package boundary violations in CI.

## Consequences

- Adding a new package requires deciding its position in the chain.
- Shared types must live in `protocol` (the leaf), even if only used by 2 packages.
- App-local helpers must not become hidden shared contracts; shared helpers must live in a package.
