# packages/openomni

Orchestration layer for `@openomni/openomni`. Builds on `@openomni/agent`, `@openomni/session`, and `@openomni/llm` to add plan generation, DAG utilities, inbound event handling, task persistence, and a session-backed subagent runtime.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/plan/` | LLM-driven plan generation and gating | `PlanAgent`, `runPlan`, `PlanStore`, `SqlitePlanStore`, `Hashline`, `StructuralGate`, `PLAN_TOOL_SPECS`, `createPlanToolExecutor` |
| `src/dag/` | Pure dependency-graph utilities | `DAG` |
| `src/ingress/` | Inbound event resolution and mode dispatch | `IngressEngine`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge` |
| `src/storage/` | Shared task type re-exports | `Task` (re-exported from `@openomni/protocol`) |
| `src/subagent/` | Session-backed subagent execution | `SubagentRuntime`, `SubagentConsultation`, `BackgroundManager` |
| `src/execution-runtime/` | Tool system, workspace, and worker middleware | `buildWorkerMiddleware`, `WorkspaceLock`, `AgentToolProvider`, `SystemToolProvider`, `ToolProxyProvider`, `TaskToolProvider`, `PlanToolProvider`, `TodoToolProvider`, `Tool`, `buildToolCatalog`, `createToolExecutor`, `createWorkerSubagentRuntime`, `defineTool` |

## Architecture

- `src/dag/` is structural only — it knows step topology, not runtime state.
- `src/plan/` turns a goal into a plan via `runPlan()` → `PlanAgent.create()`. The LLM uses plan tools (`plan_write`, `plan_read`, `plan_edit`, `plan_list`) to write plans directly to `Storage.PlanSubAdapter`. Result is a `{ planId }` reference.
- `src/ingress/` is the entry path for inbound events. It resolves a session through `SurfaceKey`, projects the event into stored messages, then dispatches to the `plan` or `direct` handler. `SessionBridge` manages plan storage via `Storage.PlanSubAdapter` (plan ID markers on messages).
- `src/storage/` is now a thin re-export shim. Task types (`Task.Info`, `Task.Run`, `Task.Status`) moved to `@openomni/protocol/task` and are re-exported here for backward compatibility. Task, plan, and todo persistence is handled by the optional sub-adapters on `Storage.Adapter` in `@openomni/session`.
- `src/subagent/` owns the unified subagent runtime. `SubagentRuntime` runs session-locked spawn / send / resume / cancel / wait operations backed by `WorkerRun` records; `BackgroundManager` wraps the runtime for fire-and-forget execution with concurrency / depth limits.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Dependency Shape

```
dag/                → no internal deps
plan/               → dag/
storage/            → no orchestration deps (re-exports from @openomni/protocol)
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → plan/
subagent/           → execution-runtime/ (uses @openomni/agent + @openomni/session + protocol directly)
```

`src/index.ts` re-exports the public surface — use the package barrel instead of deep imports from consumer code.

## Public Surface

Consumers should only use `@openomni/openomni` exports:

- Plan generation + plan tooling from `src/plan/`
- DAG helpers from `src/dag/`
- Ingress orchestration from `src/ingress/`
- Task type re-exports from `src/storage/` (persistence is in `@openomni/session`)
- Subagent runtime + background manager from `src/subagent/`
- Tool system, workspace lock, and worker middleware from `src/execution-runtime/`

If a symbol is not re-exported from `src/index.ts`, treat it as private to its domain.

## Extension Points

- Add new plan tools in `src/plan/plan-tools.ts` (specs + executor). Plan tools are always available to `PlanAgent.create()` and `runPlan()`.
- Add new gates or enrichers in `src/plan/` so validation stays next to planning.
- Add new tools or tool providers in `src/execution-runtime/tool/` following the `ToolProvider` interface. The three new providers (`TaskToolProvider`, `PlanToolProvider`, `TodoToolProvider`) each live in their own subdirectory (`task/`, `plan/`, `todo/`) and read from `Storage.get()` in `@openomni/session`.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.
- Add subagent capabilities (new timeout policies, abort semantics, recovery hooks) in `src/subagent/` next to `SubagentRuntime` / `BackgroundManager`.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD, event log, worker runs, and artifact storage.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core.

## Domain Docs

- `src/plan/AGENTS.md` — plan generation, gates, and plan tools
- `src/dag/AGENTS.md` — dependency-graph helpers
- `src/ingress/AGENTS.md` — inbound event handling and mode dispatch
- `src/storage/AGENTS.md` — task type re-exports (persistence moved to `@openomni/session`)
- `src/subagent/AGENTS.md` — session-backed subagent runtime and background manager
- `src/execution-runtime/AGENTS.md` — tool system, workspace lock, and worker middleware

## Style Rules

See `.sisyphus/rules/modular-code-enforcement.md`. Keep package-level notes short, link to the owning domain doc, and avoid repeating API details.

## Maintenance Notes

- Update this file when a new domain folder becomes part of the package surface.
- Keep the module map aligned with `src/index.ts` exports and the domain AGENTS files.
- Prefer links to the domain docs over adding implementation detail here.
- Revisit the dependency shape when a domain starts importing a new sibling.
