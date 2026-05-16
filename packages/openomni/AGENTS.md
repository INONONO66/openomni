# packages/openomni

Orchestration layer for `@openomni/openomni`. Builds on `@openomni/agent`, `@openomni/session`, and `@openomni/llm` to add DAG utilities, inbound event handling, and a session-backed subagent runtime. This package is the future home for the Main Persona orchestration seams: controlled inbound authority, self-loop session creation, persona delegation, and distilled writeback.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/dag/` | Pure dependency-graph utilities | `DAG` |
| `src/ingress/` | Inbound event resolution and mode dispatch | `IngressEngine`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge` |
| `src/runtime/` | Session bus transport bridge | `BusTransport`, `Transport` |
| `src/subagent/` | Session-backed subagent execution | `SubagentRuntime`, `SubagentConsultation`, `BackgroundManager` |
| `src/execution-runtime/` | Tool system, workspace, and worker middleware | `buildWorkerMiddleware`, `WorkspaceLock`, `AgentToolProvider`, `SystemToolProvider`, `ToolProxyProvider`, `Tool`, `buildToolCatalog`, `createToolExecutor`, `createWorkerSubagentRuntime`, `defineTool` |

## Architecture

- `src/dag/` is structural only — it knows step topology, not runtime state.
- `src/ingress/` is the entry path for inbound events. It resolves a session through `SurfaceKey`, projects the event into stored messages, then dispatches to the `direct` handler.
- `src/subagent/` owns the unified subagent runtime. `SubagentRuntime` runs session-locked spawn / send / resume / cancel / wait operations backed by `WorkerRun` records; `BackgroundManager` wraps the runtime for fire-and-forget execution with concurrency / depth limits.
- Persona workforce direction: `src/ingress/` remains the external/internal inbound seam, `src/subagent/` remains the child persona execution seam, and a future self-loop/writeback layer should live in this package rather than in `agent`.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Dependency Shape

```
dag/                → no internal deps
runtime/            → @openomni/session + @openomni/agent transport contracts
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → no sibling deps
subagent/           → execution-runtime/ (uses @openomni/agent + @openomni/session + protocol directly)
```

`src/index.ts` re-exports the public surface — use the package barrel instead of deep imports from consumer code.

## Public Surface

Consumers should only use `@openomni/openomni` exports:

- DAG helpers from `src/dag/`
- Ingress orchestration from `src/ingress/`
- Bus transport bridge from `src/runtime/`
- Subagent runtime + background manager from `src/subagent/`
- Tool system, workspace lock, and worker middleware from `src/execution-runtime/`

If a symbol is not re-exported from `src/index.ts`, treat it as private to its domain.

## Extension Points

- Add new tools or tool providers in `src/execution-runtime/tool/` following the `ToolProvider` interface.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.
- Add subagent capabilities (new timeout policies, abort semantics, recovery hooks) in `src/subagent/` next to `SubagentRuntime` / `BackgroundManager`.
- Add persona workforce orchestration here when implementing persona runtime contracts: authority checks near ingress, self-loop creation near session-backed orchestration, and distilled writeback near `SessionBridge`.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD, event log, worker runs, and artifact storage.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core.

## Domain Docs

- `src/dag/AGENTS.md` — dependency-graph helpers
- `src/ingress/AGENTS.md` — inbound event handling and mode dispatch
- `src/subagent/AGENTS.md` — session-backed subagent runtime and background manager
- `src/execution-runtime/AGENTS.md` — tool system, workspace lock, and worker middleware

## Style Rules

See `.sisyphus/rules/modular-code-enforcement.md`. Keep package-level notes short, link to the owning domain doc, and avoid repeating API details.

## Maintenance Notes

- Update this file when a new domain folder becomes part of the package surface.
- Keep the module map aligned with `src/index.ts` exports and the domain AGENTS files.
- Prefer links to the domain docs over adding implementation detail here.
- Revisit the dependency shape when a domain starts importing a new sibling.
