# execution-runtime/

Tool system, workspace safety, and worker middleware for `@openomni/openomni`. This domain is used by server workers and subagent execution, but it must stay independent from high-level orchestration policy.

## Files

| Path | Purpose |
| --- | --- |
| `middleware.ts` | Builds default worker middleware registrations. |
| `workspace-lock.ts` | Serializes workspace-mutating tool execution. |
| `injection-queue.ts` | `InjectionQueue` — async response buffer keyed by `runId`; drained at `turn.finish` by the injection-queue policy. |
| `cron-job-registry.ts` | `CronJobRegistry` — in-memory registry of scheduled jobs; populated by `dispatch` `schedule.create` action, read by `CronAdapter`. |
| `filesystem/` | Path containment helpers for file tools. |
| `tool/` | Tool definition, catalog, providers, executor, and built-in tools. |
| `tool/agent/tools/dispatch.ts` | `createDispatchTool` — cross-session orchestration gate for worker/resident/schedule actions. |

## Ownership

- System tools (`bash`, read/glob/grep/write/edit) live under `tool/builtins/` and `tool/system/`.
- Agent delegation tools live under `tool/agent/`. The cross-session orchestration tool is `dispatch` (`tool/agent/tools/dispatch.ts`). The in-session child execution tool is `subagent` (`tool/agent/tools/subagent.ts`).
- Server-specific MCP and custom provider wiring stays in `apps/server/src/tool/`; this package owns only reusable execution-runtime providers.

## dispatch tool

`createDispatchTool(dispatchRuntime)` returns the `dispatch` tool. It submits cross-session actions through the Dispatch policy/audit gate (`src/dispatch/runtime.ts`).

Built-in actions:

| Action | Behavior |
| --- | --- |
| `worker.spawn` | Creates a new independent WorkerRun via coordinator. |
| `worker.send` | Delivers a message to an existing Worker session. |
| `worker.resume` | Resumes a waiting Worker. |
| `worker.cancel` | Cancels a running Worker. |
| `resident.deliver` | Delivers a message to the Resident session. |
| `schedule.create` | Registers a cron job via `CronJobRegistry`; `CronAdapter` fires it on schedule. |
| `schedule.cancel` | Cancels a scheduled job. |

Key parameters:

- `action`: the dispatch action string.
- `target.kind`: `"worker"`, `"resident"`, or `"schedule"`.
- `wait`: if `true`, blocks until the target responds (up to `timeoutMs`).
- Actor identity is runtime-derived from implicit inputs (`sessionId`, `runId`, `agentName`) — not model-specified.

Plugin actions (e.g., `surface.send.*`, `external.invoke.*`) can be registered via `Dispatch.Registry.register()`.

## Safety rules

- File tools must use `filesystem/workspace-path.ts` containment helpers.
- Workspace-mutating tools must go through `WorkspaceLock` unless they are explicitly concurrency-safe.
- Tool denial, timeout, unknown-tool, and thrown-error paths must return error-shaped `Tool.Result` values.
- New built-in tools require tests for permission, path containment, timeout behavior where relevant, and output shape.
- Do not add ingress/session routing policy here. Put policy in `src/ingress/` or `src/dispatch/` and pass execution context down.

## Cleanup notes

- `tool/mcp-proxy-provider.ts` is currently an empty orphan candidate. Delete it once no references exist.
