# Repository Guidelines

This document records the repository-wide operating rules that keep OpenOmni aligned with its layered architecture. It complements [Golden Principles](./golden-principles.md), which defines hard invariants.

## Current posture

OpenOmni is in an entropy-management phase. The dependency graph, package ownership model, and core design patterns are already established; most near-term improvement work should reduce drift rather than introduce new architecture.

Priority order:

1. Keep docs current with code structure.
2. Keep tests discoverable in both local and CI workflows.
3. Remove compatibility shims only after all consumers are verified.
4. Strengthen security and recovery tests around tool execution, inbound authority, credentials, and persistence.

## Source-of-truth hierarchy

Use this order when deciding where a concept belongs:

| Concept | Source of truth | Notes |
| --- | --- | --- |
| Cross-package schema or event | `packages/protocol/src/{domain}/` | Zod-first; no runtime logic. |
| Durable session state | `packages/session/src/` | Session, storage adapters, event log, worker runs, artifacts, todos. |
| LLM provider behavior | `packages/llm/src/` | Auth, provider SDK wiring, transforms, token/cost tracking. |
| Stateless agent execution | `packages/agent/src/core/` | No durable session lifecycle or storage ownership. |
| Agent runtime helpers | `packages/agent/src/runtime/` | Messenger, registry, subagent/background tools, MCP client. |
| Session-backed orchestration | `packages/openomni/src/` | Ingress, subagent runtime, execution runtime. |
| Multiprocess execution | `packages/coordinator/src/` | Worker pool, IPC, recovery, credentials, non-interactive permissions. |
| Product-facing host | `apps/server/src/` | Channels, bootstrap, app-local agents, ingress bridge. |
| Linux daemon packaging | `packaging/` | Systemd user-service scripts and docs. |

## Contract placement rules

- Put cross-package contracts in `@openomni/protocol` first.
- Do not redefine protocol contracts in upper layers with new Zod schemas.
- Upper layers may expose runtime wrappers around protocol contracts when they add behavior, such as `Session.Todo.update()` publishing bus events.
- App-local interfaces are allowed for external API payloads and host wiring, but they must not become hidden shared contracts.
- If an app-local type starts being imported across package boundaries, promote it to `protocol` or keep it behind a package barrel in the owning package.

Known watchpoints:

| Item | Current status | Rule |
| --- | --- | --- |
| `apps/server/src/agents/types.ts` | Server-local agent definition with trigger metadata. | Keep app-local unless reused outside `apps/server`; promote persistent persona contracts to `protocol`. |
| `packages/openomni/src/storage/task-types.ts` | Backward-compat task re-export shim. | Remove only after migration scripts import `Task` from `@openomni/protocol` directly. |
| `packages/agent/src/core/middleware/compat.ts` | Legacy hooks/stepGuard bridge. | No new callers; remove after downstream migration. |
| Removed CLI auth/config flow | `apps/cli` has been removed. | Keep auth/config setup in proxy/provider configuration or server/operator flows; do not reintroduce a CLI without a new ADR. |

## Test matrix expectations

Use both package scripts and direct Bun discovery deliberately:

```bash
bun run check-types
bun run script/check-deps.ts
bun run lint
bun test
```

Notes:

- CI runs package tests plus direct app tests for `apps/server`.
- `turbo run test` only runs workspaces with a `test` task. If a future app lacks a `test` script, local Turbo runs can differ from direct Bun discovery.
- Coverage reporting is enabled through `bunfig.toml`, but no threshold is enforced yet.
- `dist/` is ignored build output. If `dist/**/*.test.js` appears locally, clean build artifacts before trusting local test counts.

Test quality rules:

- New features require behavior tests, not only export-shape checks.
- Bug fixes require regression tests that fail without the fix.
- Avoid tautological assertions such as `expect(true).toBe(true)` unless the test is explicitly compile-time or no-throw oriented and the intent is documented.
- Tool changes must include denial, timeout, path containment, and error-result cases where applicable.
- Persistence changes must include recovery, idempotency, and migration coverage.

Highest-priority coverage gaps:

1. `apps/server/src/channel/` Discord, Telegram, and GitHub normalizers/webhooks/pollers.
2. `packages/openomni/src/execution-runtime/tool/builtins/` filesystem and shell tools.
3. `packages/agent/src/core/execution/` StreamEngine turn/retry/middleware interactions.
4. `packages/agent/src/runtime/mcp/` MCP client lifecycle and failure paths.
5. `packages/session/src/snapshot/`, `trace/`, and direct telemetry behavior.

## Documentation maintenance rules

When a change affects structure, commands, contracts, or public behavior, update docs in the same change.

Required updates by change type:

| Change type | Required docs |
| --- | --- |
| Package/domain added, removed, or renamed | Root `AGENTS.md`, package `AGENTS.md`, README if user-facing. |
| Cross-package contract added or moved | `docs/golden-principles.md` if rule changes, protocol package docs, root WHERE TO LOOK table. |
| Runtime mode added or removed | README runtime section, root `AGENTS.md`, `apps/server/AGENTS.md`, ADR index. |
| Quality/test status changes materially | `docs/quality-score.md`. |
| ADR created | `docs/design-decisions/index.md`. |
| New operational script or packaging path | README or a linked docs page. |

`*.local.md` files are design references, not committed source-of-truth. If a local insight becomes policy, promote it into committed docs with current paths and an ADR if it changes architecture.

## Cleanup backlog

| Priority | Item | Why |
| --- | --- | --- |
| High | Keep root/package docs aligned with the single server app topology. | `apps/cli` has been removed. |
| High | Keep app-level test scripts and CI direct app tests aligned. | Avoid local `turbo run test` ambiguity. |
| Medium | Delete empty `packages/openomni/src/execution-runtime/tool/mcp-proxy-provider.ts`. | Strong orphan candidate. |
| Medium | Replace `packages/openomni/src/storage/task-types.ts` consumers with `@openomni/protocol`. | Removes compatibility shim. |
| Medium | Reduce lint warnings, especially non-null assertions and `any`. | Keeps type-safety rules credible. |
