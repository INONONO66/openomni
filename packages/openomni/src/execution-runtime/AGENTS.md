# Execution Runtime Notes

Tool system, workspace safety, injection queue, cron bridge, and worker middleware for `@openomni/openomni`. This domain is used by server workers and must stay independent from high-level orchestration policy.

## Files

| Path | Purpose |
| --- | --- |
| `middleware.ts` | Builds worker middleware registrations from the gate-stamped `Execution.Request.policyPlan` (#479); builtin ids resolve through `defaultRegistry(events)` plus this package's own registrations (`registerIdleNudge` #625, `registerBudgetNudges` #626, `registerToolPermission` #629), `builtin:tool-permission` config is hydrated from `request.permissions`, required-but-unregistered ids fail closed. |
| `workspace-lock.ts` | Serializes workspace-mutating tool execution. |
| `injection-queue.ts` | `InjectionQueue` — async response buffer keyed by `runId`; drained at `turn.finish` by the injection-queue policy. |
| `cron-job-registry.ts` | `CronJobRegistry` — storage-backed registry of scheduled jobs with a process-local fallback; populated by `dispatch` `schedule.create` action. |
| `cron-job-runner.ts` | `CronJobRunner` — boot/timer runner that polls `CronJobRegistry`, advances `nextFireAt`, emits fire events, and calls an injected fire implementation. |
| `filesystem/` | Path containment helpers for file tools. |
| `tool/` | Tool definition, catalog, providers, executor, and built-in tools. |
| `tool/agent/tools/dispatch.ts` | `createDispatchTool` — runtime-to-runtime/system egress gate. |

## Ownership

- System tools (`bash`, read/glob/grep/write/edit) live under `tool/builtins/` and `tool/system/`.
- Agent delegation tools live under `tool/agent/`. The cross-session egress tool is `dispatch` (`tool/agent/tools/dispatch.ts`). The in-session lightweight `child_agent` tool (`tool/agent/tools/child-agent.ts`) is Worker-local; the Resident never receives it.
- Server-specific MCP and custom provider wiring stays in `apps/server/src/tool/`; this package owns only reusable execution-runtime providers.

This domain may expose tools that call communication kernel APIs. It must not make routing or authority decisions itself.

## dispatch tool

`createDispatchTool(dispatchRuntime)` returns the cross-boundary `dispatch` tool. It submits actions through the Dispatch policy/audit gate (`src/dispatch/runtime.ts`). The full tool is for Resident/kernel-authorized callers; Worker-runner currently exposes a narrower surface that allows only awaited `resident.ask`. Granted messaging to an already-existing agent, including durable WorkItem `Wait` for the awaited form, is the #215 target rather than wired behavior. Neither form transfers allocation: only the Resident originates new Worker work, and fire-and-forget messaging creates no `Wait`. See the canonical role lanes in the [core model](../../../../docs/core-model.md) and Wait semantics in the [kernel contract](../../../../docs/kernel-contract.md).

The tool wrapper is not the authority boundary. The boundary is the OpenOmni dispatch/communication kernel. Keep validation here limited to tool input shape and runtime implicit inputs. Policy interception is system-wide across actor profiles; tool exposure alone grants no authority.

Built-in handlers exist for the following actions; handler existence does not grant every actor access:

| Action | Behavior | Actor availability |
| --- | --- | --- |
| `worker.spawn` | Creates a new independent Worker attempt via coordinator | Resident-origin dispatch only |
| `worker.send` | Delivers a message to an existing Worker session | Explicit grant supported; not exposed by the current Worker tool |
| `worker.resume` | Resumes a waiting Worker | Explicit grant supported; not exposed by the current Worker tool |
| `worker.cancel` | Cancels a running Worker | Explicit grant supported; not exposed by the current Worker tool |
| `resident.ask` | Sends an awaited Worker question to the Resident | Worker narrow dispatch surface |
| `schedule.create` | Registers a cron job via `CronJobRegistry`; `CronAdapter` fires it as internal ingress | Authorized non-Worker caller |
| `schedule.cancel` | Cancels a scheduled job | Authorized non-Worker caller |

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
- Do not add ingress/session routing policy here. Put policy in the kernel stages (`src/ingress/` / `src/dispatch/`) and use the shipped #464 `resolveRoute` path; pass execution context down.
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
| `child_agent` | In-process child execution inside a worker run | Internal only | LOW | No external network; further delegation requires `dispatch`. |
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

**`web_search` and `web_fetch` — Owner-authorized, Resident-only read/perception exception:**
These make direct `fetch()` calls through `opensearch-ai-sdk` to an external search/fetch service. They live exclusively in `apps/server/src/tool/custom/CustomToolProvider` and are never included in the Worker tool catalog (`worker-runner.ts` assembles only `systemTools + agentTools + proxyTools`). The Owner is the root authority; this narrow exception exists because the Owner explicitly authorizes these read/perception capabilities for the Resident. Its safety derives from that authorization, read-only effect classification, and Resident-only catalog boundary — never from authority inherent to the Resident.

Decision: **approved only within that boundary**. Workers remain excluded. Any mutation or other boundary-crossing effect still uses `dispatch`; if either tool becomes mutating or is added to a Worker catalog, this exception no longer applies and the capability must be reclassified and gated.

