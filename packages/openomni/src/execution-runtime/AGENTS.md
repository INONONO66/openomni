# execution-runtime/

Tool system, workspace safety, and worker middleware for `@openomni/openomni`. This domain is used by server workers and subagent execution, but it must stay independent from high-level orchestration policy.

## Files

| Path | Purpose |
| --- | --- |
| `middleware.ts` | Builds default worker middleware registrations. |
| `workspace-lock.ts` | Serializes workspace-mutating tool execution. |
| `injection-queue.ts` | `InjectionQueue` — async response buffer keyed by `runId`; drained at `turn.finish` by the injection-queue policy. |
| `cron-job-registry.ts` | `CronJobRegistry` — in-memory registry of scheduled jobs; populated by `inbound_message` `schedule` action, read by `CronAdapter`. |
| `filesystem/` | Path containment helpers for file tools. |
| `tool/` | Tool definition, catalog, providers, executor, and built-in tools. |
| `tool/agent/tools/inbound-message.ts` | `createInboundMessageTool` — cross-sandbox IPC syscall; replaces legacy per-action tools. |

## Ownership

- System tools (`bash`, read/glob/grep/write/edit) live under `tool/builtins/` and `tool/system/`.
- Agent delegation tools live under `tool/agent/`. The primary agent IPC tool is `inbound_message` (`tool/agent/tools/inbound-message.ts`).
- Server-specific MCP and custom provider wiring stays in `apps/server/src/tool/`; this package owns only reusable execution-runtime providers.

## inbound_message tool

`createInboundMessageTool(ingressEngine)` returns the `inbound_message` tool. It is the single cross-sandbox IPC primitive for worker agents.

Actions:

| Action | Behavior |
| --- | --- |
| `spawn` | Creates a new worker agent session and sends the payload. |
| `send` | Delivers a message to an existing resident or worker agent. |
| `cancel` | Cancels a running worker agent. |
| `resume` | Resumes a paused worker agent. |
| `schedule` | Registers a cron job via `CronJobRegistry`; `CronAdapter` fires it on schedule. |

Key parameters:

- `target.kind`: `"resident"` or `"worker"`.
- `wait`: if `true`, blocks until the target responds (up to `timeoutMs`, default 30 s). Worker run status transitions to `waiting_input` while blocked.
- `injectToHistory`: if `true`, the response is injected into the caller's conversation history at `turn.finish` via `InjectionQueue`.
- `depth`: auto-incremented; capped at 10 to prevent runaway delegation chains.

## Safety rules

- File tools must use `filesystem/workspace-path.ts` containment helpers.
- Workspace-mutating tools must go through `WorkspaceLock` unless they are explicitly concurrency-safe.
- Tool denial, timeout, unknown-tool, and thrown-error paths must return error-shaped `Tool.Result` values.
- New built-in tools require tests for permission, path containment, timeout behavior where relevant, and output shape.
- Do not add ingress/session routing policy here. Put policy in `src/ingress/` or `src/subagent/` and pass execution context down.

## Cleanup notes

- `tool/mcp-proxy-provider.ts` is currently an empty orphan candidate. Delete it once no references exist.
