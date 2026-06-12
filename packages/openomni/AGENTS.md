# packages/openomni

Orchestration layer for `@openomni/openomni`. Builds on `@openomni/agent`, `@openomni/session`, and `@openomni/llm` to add DAG utilities, inbound event handling, and a session-backed subagent runtime. This package is the future home for Resident orchestration seams: controlled inbound authority, self-loop session creation, Worker delegation, and distilled writeback.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/agents/` | Built-in agent definitions and model-specific prompt variants | `ResidentAgent` |
| `src/app-connector/` | Built-in declarative connector definitions, local detect-command discovery, and installation registration for CLI apps | `BuiltInAppConnectors`, `AppConnectorDiscovery`, `AppConnectorRegistry` |
| `src/dag/` | Pure dependency-graph utilities | `DAG` |
| `src/profile/` | Agent profile middleware (soul/user/memory from `~/.openomni/profiles/`) | `Profile` |
| `src/resident/` | Resident runtime lifecycle (in-process execution, direct mode) | `ResidentRuntime` |
| `src/ingress/` | Inbound event resolution and mode dispatch | `IngressEngine`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge`, `CronAdapter`, `resolveTarget`, `targetKey` |
| `src/runtime/` | Worker middleware and session utilities | *(no public exports; internal wiring only)* |
| `src/subagent/` | Session-backed subagent execution | `SubagentRuntime`, `SubagentConsultation`, `BackgroundManager` |
| `src/execution-runtime/` | Tool system, workspace, worker middleware, and scheduled job runtime | `buildWorkerMiddleware`, `WorkspaceLock`, `AgentToolProvider`, `SystemToolProvider`, `ToolProxyProvider`, `Tool`, `buildToolCatalog`, `createToolExecutor`, `createWorkerSubagentRuntime`, `defineTool`, `InjectionQueue`, `CronJobRegistry`, `CronJobRunner` |

## Architecture

- `src/agents/` contains built-in agent definitions. `src/agents/resident/prompt/` holds the Resident system prompt with model-specific variants (Claude, GPT) and a shared builder. `ResidentAgent.getPrompt({ model })` selects the right variant by provider.
- `src/app-connector/` contains declarative installed-app connector definitions, detect-command discovery, and durable registration of available candidates. Consent, hook/credential wiring, process execution, and log ingestion stay out of this module.
- `src/dag/` is structural only — it knows step topology, not runtime state.
- `src/profile/` loads `SOUL.md`, `USER.md`, and `MEMORY.md` from the file system and injects them as `context.prepare` policy effects before agent execution.
- `src/resident/` provides `ResidentRuntime` for in-process Resident execution without coordinator dispatch.
- `src/ingress/` is the entry path for inbound events. It resolves a session through `SurfaceKey`, projects the event into stored messages, then dispatches to the `direct` handler. `ingestInternal()` accepts internal-origin events (e.g., from `CronAdapter`) without going through the external ingest path. `CronAdapter.fire(job)` creates internal events with `surface="cron"`.
- `src/subagent/` owns the unified subagent runtime. `SubagentRuntime` runs session-locked spawn / send / resume / cancel / wait operations backed by `WorkerRun` records; `BackgroundManager` wraps the runtime for fire-and-forget execution with concurrency / depth limits.
- `src/execution-runtime/tool/agent/tools/dispatch.ts` is the `dispatch` tool — the runtime-to-runtime/system egress gate. Worker-to-Resident awaited requests use `resident.ask`; scheduling uses `schedule.create`; cron fire remains internal ingress. `Dispatch.submit()` enforces PolicyEngine authorization and emits Bus audit events. See `src/dispatch/` for the runtime, handlers, and policy.
- `src/execution-runtime/injection-queue.ts` (`InjectionQueue`) holds async responses keyed by `runId`. The worker middleware drains the queue at `turn.finish` and injects pending responses into the agent's next turn.
- `src/execution-runtime/cron-job-registry.ts` (`CronJobRegistry`) stores scheduled jobs through the session storage adapter and keeps a process-local fallback map when durable storage is absent. `src/execution-runtime/cron-job-runner.ts` (`CronJobRunner`) polls the registry and accepts an injected fire implementation; server boot wires that to `CronAdapter.fire(job)`.
- Persona workforce direction: Resident orchestration seams: controlled inbound authority, self-loop session creation, Worker delegation, and distilled writeback.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Dependency Shape

```
agents/             → @openomni/protocol (Model.Ref only)
app-connector/      → @openomni/protocol (AppConnector.Definition only)
dag/                → no internal deps
profile/            → @openomni/session + @openomni/agent + @openomni/protocol
resident/           → @openomni/session + @openomni/agent + @openomni/llm
runtime/            → @openomni/session + @openomni/agent (worker middleware, no bus transport)
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → no sibling deps
subagent/           → execution-runtime/ (uses @openomni/agent + @openomni/session + protocol directly)
```

`src/index.ts` re-exports the public surface — use the package barrel instead of deep imports from consumer code.

## Public Surface

Consumers should only use `@openomni/openomni` exports:

- Resident agent prompts from `src/agents/`
- Built-in installed-app connector definitions, discovery results, and registration records from `src/app-connector/`
- DAG helpers from `src/dag/`
- Profile middleware from `src/profile/`
- Resident runtime from `src/resident/`
- Ingress orchestration from `src/ingress/`

- Subagent runtime + background manager from `src/subagent/`
- Tool system, workspace lock, worker middleware, and cron runtime from `src/execution-runtime/`

If a symbol is not re-exported from `src/index.ts`, treat it as private to its domain.

## Extension Points

- Add new tools or tool providers in `src/execution-runtime/tool/` following the `ToolProvider` interface.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.
- Add subagent capabilities (new timeout policies, abort semantics, recovery hooks) in `src/subagent/` next to `SubagentRuntime` / `BackgroundManager`.
- Add Resident/Worker orchestration here when implementing product model contracts: authority checks near ingress, self-loop creation near session-backed orchestration, and distilled writeback near `SessionBridge`.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD, event log, worker runs, and artifact storage.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core.

## Domain Docs

- `src/dag/AGENTS.md` — dependency-graph helpers
- `src/profile/AGENTS.md` and `src/resident/AGENTS.md` do not exist yet; these are intentionally small modules.
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
