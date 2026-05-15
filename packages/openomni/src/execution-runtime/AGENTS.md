# execution-runtime/

Tool system, workspace safety, and worker middleware for `@openomni/openomni`. This domain is used by server workers and subagent execution, but it must stay independent from high-level orchestration policy.

## Files

| Path | Purpose |
| --- | --- |
| `middleware.ts` | Builds default worker middleware registrations. |
| `workspace-lock.ts` | Serializes workspace-mutating tool execution. |
| `filesystem/` | Path containment helpers for file tools. |
| `tool/` | Tool definition, catalog, providers, executor, and built-in tools. |

## Ownership

- System tools (`bash`, read/glob/grep/write/edit) live under `tool/builtins/` and `tool/system/`.
- Agent delegation tools live under `tool/agent/`.
- Server-specific MCP and custom provider wiring stays in `apps/server/src/tool/`; this package owns only reusable execution-runtime providers.

## Safety rules

- File tools must use `filesystem/workspace-path.ts` containment helpers.
- Workspace-mutating tools must go through `WorkspaceLock` unless they are explicitly concurrency-safe.
- Tool denial, timeout, unknown-tool, and thrown-error paths must return error-shaped `Tool.Result` values.
- New built-in tools require tests for permission, path containment, timeout behavior where relevant, and output shape.
- Do not add ingress/session routing policy here. Put policy in `src/ingress/` or `src/subagent/` and pass execution context down.

## Cleanup notes

- `tool/mcp-proxy-provider.ts` is currently an empty orphan candidate. Delete it once no references exist.
