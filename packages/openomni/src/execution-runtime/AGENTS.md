# Execution Runtime Notes

Tool system, workspace safety, injection queue, cron bridge, and worker middleware for `@openomni/openomni`. This domain is used by server workers and subagent execution, but it must stay independent from high-level communication and authority policy.

## Files

| Path | Purpose |
| --- | --- |
| `middleware.ts` | Builds default worker middleware registrations. |
| `workspace-lock.ts` | Serializes workspace-mutating tool execution. |
| `injection-queue.ts` | `InjectionQueue` — async response buffer keyed by `runId`; drained at `turn.finish` by the injection-queue policy. |
| `cron-job-registry.ts` | `CronJobRegistry` — storage-backed registry of scheduled jobs with a process-local fallback; populated by `dispatch` `schedule.create` action. |
| `cron-job-runner.ts` | `CronJobRunner` — boot/timer runner that polls `CronJobRegistry`, advances `nextFireAt`, emits fire events, and calls an injected fire implementation. |
| `filesystem/` | Path containment helpers for file tools. |
| `tool/` | Tool definition, catalog, providers, executor, and built-in tools. |
| `tool/agent/tools/dispatch.ts` | `createDispatchTool` — runtime-to-runtime/system egress gate. |

## Ownership

- System tools (`bash`, read/glob/grep/write/edit) live under `tool/builtins/` and `tool/system/`.
- Agent delegation tools live under `tool/agent/`. The cross-session egress tool is `dispatch` (`tool/agent/tools/dispatch.ts`), but it is only a tool wrapper over the OpenOmni dispatch/communication kernel. The in-session child execution tool is `subagent` (`tool/agent/tools/subagent.ts`).
- Server-specific MCP and custom provider wiring stays in `apps/server/src/tool/`; this package owns only reusable execution-runtime providers.

This domain may expose tools that call communication kernel APIs. It must not make routing or authority decisions itself.

## dispatch tool

`createDispatchTool(dispatchRuntime)` returns the `dispatch` tool. It submits egress actions through the Dispatch policy/audit gate (`src/dispatch/runtime.ts`). Worker-runner uses a narrower dispatch surface that only allows awaited `resident.ask`.

The tool wrapper is not the authority boundary. The boundary is the OpenOmni dispatch/communication kernel. Keep validation here limited to tool input shape and runtime implicit inputs.

Built-in actions:

| Action | Behavior |
| --- | --- |
| `worker.spawn` | Creates a new independent WorkerRun via coordinator when explicitly granted. |
| `worker.send` | Delivers a message to an existing Worker session when explicitly granted. |
| `worker.resume` | Resumes a waiting Worker when explicitly granted. |
| `worker.cancel` | Cancels a running Worker when explicitly granted. |
| `resident.ask` | Sends an awaited Worker question to the Resident. |
| `schedule.create` | Registers a cron job via `CronJobRegistry`; `CronAdapter` fires it as internal ingress. |
| `schedule.cancel` | Cancels a scheduled job. |

Key parameters:

- `action`: the dispatch action string.
- `target.kind`: `"worker"`, `"resident"`, `"schedule"`, or `"external_actor"`.
- `wait`: if `true`, blocks until the target responds (up to `timeoutMs`).
- Actor identity is runtime-derived from implicit inputs (`sessionId`, `runId`, `agentName`) — not model-specified.

Plugin actions (e.g., `surface.send.*`, `external.invoke.*`) can be registered via `DispatchRegistry.register()`.

Do not reintroduce the removed legacy model-facing inbound tool or compatibility alias.

## Safety rules

- File tools must use `filesystem/workspace-path.ts` containment helpers.
- Workspace-mutating tools must go through `WorkspaceLock` unless they are explicitly concurrency-safe.
- Tool denial, timeout, unknown-tool, and thrown-error paths must return error-shaped `Tool.Result` values.
- New built-in tools require tests for permission, path containment, timeout behavior where relevant, and output shape.
- Do not add ingress/session routing policy here. Put policy in OpenOmni communication/authority stages (`src/communication/`, `src/authority/`, or transitional `src/ingress/` / `src/dispatch/`) and pass execution context down.
- Do not query `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WorkerGrantStore`, `ChannelGrantStore`, or `BlacklistStore` from tool wrappers for routing.

## Data Egress Gate

All external communication must be auditable and policy-gated. The canonical egress gate is the `dispatch` tool (`tool/agent/tools/dispatch.ts`), which routes every cross-boundary action through `DispatchRuntime.submit()` → PolicyEngine authorization → registered handler. See `src/dispatch/` for the runtime, handlers, and the `WorkerGrantStore`-backed authorization check.

**Invariant**: New tools that make `fetch()`, `http.*`, `axios.*`, or `Bun.spawn()` calls targeting external network destinations must either route via the `dispatch` egress gate or be explicitly approved and documented in the table below.

### Tool Egress Inventory (audited 2026-06-29)

| Tool | Network / subprocess | Egress path | Risk | Notes |
| --- | --- | --- | --- | --- |
| `dispatch` | Via `DispatchRuntime.submit()` | **Authorized gate** | Gate | All external actions must use this. Workers further constrained to `resident.ask` only. |
| `bash` | `Bun.spawn(["bash", "-lc", ...])` — arbitrary shell | **Direct — bypasses dispatch** | HIGH | Can invoke `curl`, `wget`, `nc`, etc. riskTier 2 records each call on the Bus, but no network egress audit. See gap note below. |
| `grep.search` | `Bun.spawn(["rg"/"grep", ...])` | Local filesystem only | LOW | Read-only search; no network destination possible. |
| `web_search` | `fetch()` via `opensearch-ai-sdk` | **Direct — bypasses dispatch** | MEDIUM (approved) | Resident-only (CustomToolProvider, not passed to workers). Intentional Resident capability. See approved-direct note below. |
| `web_fetch` | `fetch()` via `opensearch-ai-sdk` | **Direct — bypasses dispatch** | MEDIUM (approved) | Same as `web_search`. Resident-only. |
| `read`, `write`, `edit`, `glob` | None | n/a | NONE | Workspace-contained filesystem only. |
| `subagent` | In-process session spawn | Internal only | LOW | No external network; further delegation requires `dispatch`. |
| MCP proxy tools | IPC → server-side MCP handler | `worker.tool_call` IPC | LOW | Worker never touches the network directly; server executes MCP calls and returns results over IPC. |

### Known Gaps

**`bash` — intentional-but-uncontrolled egress:**
The bash tool does not restrict network syscalls. An agent with `bash` access can exfiltrate data via `curl`, `wget`, `python3`, or any binary on `PATH`, bypassing the dispatch audit gate entirely.

This is partially intentional (bash is a necessary general-purpose execution tool) and partially a gap (no per-call network audit). Current mitigations:
- riskTier: 2 emits `Operational.Warn` on the Bus for every invocation.
- Restricted env (`PATH`, `TMPDIR`, `TEMP`, `TMP`, `BUN_INSTALL`, `HOME=workspaceRoot`) removes credential env vars but does not block network-capable binaries already on `PATH`.
- Workers only receive `bash` if `ToolSelection` grants the `execution` category.

Future enforcement option (not yet implemented): an `invoke.prepare` middleware policy that rejects bash commands matching known network binaries (`curl`, `wget`, `nc`, `ssh`, `git clone`, etc.). Do not add without profiling legitimate bash usage patterns first.

### Approved Direct-Fetch Tools

**`web_search` and `web_fetch` (Resident-only):**
These make direct `fetch()` calls through `opensearch-ai-sdk` to an external search/fetch service. They live exclusively in `apps/server/src/tool/custom/CustomToolProvider` and are never included in the worker tool catalog (`worker-runner.ts` assembles only `systemTools + agentTools + proxyTools`). The Resident is the top-level authority and has intentional, audited-by-design web access. Routing them through dispatch would add no security value.

Decision: **approved as-is**. The boundary (Resident only, not workers) must be maintained; if `web_search`/`web_fetch` are ever added to a worker tool catalog, they must be reclassified and gated.

## Cleanup notes

- `tool/mcp-proxy-provider.ts` is currently an empty orphan candidate. Delete it once no references exist.
