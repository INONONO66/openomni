# Policy Kernel v2 Specification

Policy Kernel v2 is the governance VM for OpenOmni runtime behavior. It is not a hook collection. It is the mandatory mediation layer for every operation that can affect external state, spend resources, expose capabilities, mutate sessions, or alter an agent's behavior.

The goal is interpreter-grade stability: stable semantics, replayable decisions, deterministic composition, explicit versioning, and no ungoverned side-effect path.

## Design Goals

- **Total mediation**: every governed side effect passes through exactly one pre-boundary policy point before execution.
- **Declarative decisions**: policies return data (`PolicyDecision` with `effects[]`), not runtime mutations.
- **Canonical resources**: every governed object is represented by a stable `RuntimeResource.Descriptor`.
- **Deterministic composition**: the same request snapshot and policy set produce the same effective decision.
- **Replayable audit**: policy requests, decisions, and applied effects can be persisted and replayed for diagnosis.
- **Versioned contracts**: policy point and resource schemas evolve through versions, not silent shape changes.

## Non-goals

- Policy Kernel v2 does not make policies execute arbitrary code in privileged contexts.
- Policy Kernel v2 does not replace domain runtimes such as the worker pool, MCP client, or session storage.
- Policy Kernel v2 does not allow policies to directly mutate sessions, invoke tools, access credentials, or call external services.
- Policy Kernel v2 does not expose legacy verdict objects at policy boundaries; policies return canonical `PolicyDecision` values directly.

## Core Model

### PolicyPoint

A `PolicyPoint` is a versioned ABI contract for a governance boundary.

Each point defines:

- `id`: stable point identifier, such as `invoke.prepare`.
- `version`: integer contract version.
- `phase`: `pre`, `post`, or `error`.
- `resourceKinds`: resource kinds accepted at this point.
- `inputSchema`: validated point input.
- `requiredContext`: context fields that must exist before evaluation.
- `allowedEffects`: effect types that may be returned at this point.
- `defaultFailPolicy`: `fail-open` or `fail-closed`.
- `sideEffectBoundary`: whether the point gates a side effect that has not happened yet.

Breaking semantic changes create a new point version. Point names are not reused with incompatible behavior.

### RuntimeResource

A `RuntimeResource.Descriptor` is the canonical identity for a governed object. Policy decisions are made against descriptors, not ad-hoc strings.

Required descriptor properties:

- stable `id` using a namespaced format;
- `kind`, such as `tool`, `skill`, `mcpSource`, `policy`, `worker`, `credential`, or `session`;
- namespaced `labels`;
- `capabilities` the resource can exercise;
- `effects` the resource can cause;
- optional `risk` tier;
- optional `source` metadata;
- optional digest for replay and tamper detection.

Descriptors must be serializable, redacted, and hashable. They must not contain secrets, live handles, provider-native objects, or unbounded payloads.

Examples:

```ts
{
  id: "tool:system:bash",
  kind: "tool",
  labels: ["source.system", "risk.3", "capability.exec"],
  capabilities: ["exec", "filesystem.write"],
  effects: ["workspace.mutate"],
  risk: 3,
  source: { type: "system" }
}
```

```ts
{
  id: "mcp:github:create_issue",
  kind: "tool",
  labels: ["source.mcp", "mcp.github", "risk.2"],
  capabilities: ["network.write", "github.issue.write"],
  effects: ["external.write"],
  risk: 2,
  source: { type: "mcp", serverId: "github", remoteName: "create_issue" }
}
```

```ts
{
  id: "skill:git-master",
  kind: "skill",
  labels: ["source.project", "skill.layer.enhancement"],
  capabilities: ["behavior.inject"],
  effects: ["prompt.modify"],
  source: { type: "project" }
}
```

### ActorDescriptor

An `ActorDescriptor` identifies who is initiating the governed operation. It is part of every `PolicyRequest`.

```ts
type ActorDescriptor = {
  actorId: string;                          // stable namespaced id, e.g. "user:ino" or "agent:main-persona"
  actorType: "user" | "agent" | "system";  // coarse authority class
  agentProfileRef?: string;                 // id of the AgentProfile.Definition if actorType is "agent"
  permissions: string[];                    // granted permission labels, e.g. ["inbound.submit", "tool.exec"]
  labels: string[];                         // policy-visible labels, e.g. ["trust.owner", "surface.discord"]
};
```

`actorType: "system"` is reserved for internal kernel operations such as recovery and bootstrap. Policies may not grant `system` authority to user or agent actors.

### SessionDescriptor

A `SessionDescriptor` identifies the session context for the governed operation.

```ts
type SessionDescriptor = {
  sessionId: string;          // stable session id
  parentSessionId?: string;   // set for child/self-loop sessions
  sessionType:                // coarse session class
    | "root"                  // top-level user-facing session
    | "child"                 // delegated sub-persona session
    | "self-loop";            // isolated internal reasoning session
  ownerActorId: string;       // actorId of the session creator
};
```

Policies may use `sessionType` to restrict operations. For example, a policy may deny `session.inbound.pre` for `self-loop` sessions that attempt to create new top-level inbound work.

### PolicyRequest

Policy evaluation receives a snapshot, not live mutable state.

```ts
type PolicyRequest = {
  point: { id: string; version: number };
  resource: RuntimeResource.Descriptor;
  actor: ActorDescriptor;
  session?: SessionDescriptor;
  trace: TraceContext;
  input: unknown;
  contextSnapshot: Record<string, unknown>;
  kernelVersion: string;
};
```

The request must include every fact a policy needs for deterministic evaluation. Policies do not fetch missing facts themselves.

### PolicyDecision

Policies return decisions. Decisions are data.

```ts
type PolicyDecision = {
  policyId: string;
  policyVersion?: string;
  verdict: "allow" | "deny" | "pending";
  effects: PolicyEffect[];
  obligations?: PolicyObligation[];
  reasonCodes: string[];
  factsUsed?: string[];
  durationMs?: number;
};
```

`allow` permits the operation if the composed decision remains allow. `deny` blocks the operation. `pending` pauses the operation until declared obligations are satisfied.

### PolicyEffect

Effects are declarative instructions for trusted point adapters. Effects never execute themselves.

Effect categories:

- prompt shaping: append context, inject message, replace prompt;
- resource shaping: filter tools, rewrite tool input, skip invocation;
- run control: abort, retry after, continue with prompt;
- delegation control: set constraints, require approval;
- audit: annotate, emit decision metadata;
- writeback shaping: rewrite final output;
- runtime constraints: set timeout, set workspace lock requirement.

Each point declares its allowed effects. An effect not allowed by the point is rejected before application.

## Composition Semantics

Policy decisions are composed in deterministic order.

```text
Policy.evaluate(request) -> PolicyDecision[]

compose(decisions):
  if any decision.verdict == deny:
    return EffectiveDecision.deny
  if any decision.verdict == pending:
    return EffectiveDecision.pending
  return EffectiveDecision.allow
```

`deny` is absorbing. If any policy denies, the governed operation is not executed. Deny may only carry safe effects such as audit annotations, diagnostics, and redacted operator messages.

`pending` is second strongest. It may emit obligations such as human approval, missing evidence, or credential confirmation. The operation remains paused until the obligations are resolved.

`allow` composes non-terminal effects after validation. Effects are ordered by point-defined ordering rules, then policy priority, then policy id.

### Conflict Semantics

There is no conflict for terminal control. `deny` wins over everything, and `pending` wins over `allow`.

Non-terminal effects can still conflict. Examples:

- two policies rewrite the same tool input field with different values;
- one policy filters out a tool while another policy requires it;
- two policies replace the system prompt;
- two policies set incompatible timeouts;
- one policy requests writeback suppression while another rewrites writeback text.

These are effect conflicts, not authorization conflicts. They must be resolved by explicit per-effect merge rules. If a merge rule is not defined, the kernel rejects the composed decision instead of guessing.

Default merge rules:

- additive audit annotations append;
- prompt append effects preserve deterministic order;
- exact duplicate effects deduplicate by stable hash;
- scalar constraints use the safer value when a total order exists, such as lower timeout;
- incompatible rewrites without a merge rule fail closed at pre-boundary points;
- post-boundary conflicts may emit audit diagnostics but cannot retroactively authorize or undo the original side effect unless a compensation effect is explicitly supported.

### Per-Effect Merge Rules

Each effect category has an explicit merge rule. If no rule is defined for a conflict, the kernel rejects the composed decision.

| Effect Type | Merge Rule |
| --- | --- |
| `prompt.append_context` | Append all in policy priority order, then policy id order. No deduplication unless content hash is identical. |
| `prompt.inject_message` | Append all in priority order. Two injections with identical content and role deduplicate by hash. |
| `tool.filter` | Union of all filter patterns. A tool is filtered if any policy filters it. |
| `tool.rewrite_input` | Deep merge of input records in priority order. Later priority wins on key conflict. If two policies rewrite the same key with different values at equal priority, fail closed. |
| `tool.rewrite_output` | Only one output rewrite is active. Higher priority wins. Equal-priority incompatible rewrites fail closed at composition; post adapters treat plain post-boundary deny as diagnostic-only unless an explicit `run.abort` effect is allowed and present. |
| `tool.require_approval` | Absorbing: if any policy requires approval, the composed result requires approval. Reasons concatenate. |
| `run.abort` | Absorbing: if any policy aborts, the run aborts. First abort reason wins. |
| `run.continue_with_prompt` | Only one `run.continue_with_prompt` may be active. If two policies emit it, fail closed unless one has strictly higher priority. |
| `run.retry_after` | Use the maximum `delayMs` across all retry effects. Use the minimum `maxRetries` across all retry effects (safer bound). |
| `run.replace_messages` | Only one message replacement is active. Higher priority wins. Equal-priority incompatible replacements fail closed. |
| `delegation.set_constraints` | Deep merge of constraint records in priority order. Same key conflict at equal priority fails closed. |
| `delegation.require_approval` | Absorbing: if any policy requires approval, delegation requires approval. Reasons concatenate. |
| `writeback.rewrite` | Only one writeback rewrite is active. Higher priority wins. Equal-priority incompatible rewrites fail closed. |
| `writeback.suppress` | Suppression wins over lower- or equal-priority rewrites; equal-priority suppress/rewrite from different policies fails closed before session-visible output is stored. A higher-priority rewrite may override a lower-priority suppression. |
| `audit.annotate` | Append all annotations in priority order, then policy id order. Exact duplicate annotations deduplicate by stable effect hash. |

## Obligation Lifecycle

A `PolicyObligation` is a declared precondition that must be satisfied before the paused operation may proceed.

```ts
type PolicyObligation = {
  obligationId: string;
  kind: "human_approval" | "credential_confirmation" | "evidence_required" | "custom";
  description: string;
  timeoutMs: number;        // max wait before the obligation is considered failed
  resolvedBy?: string;      // actorId that resolved the obligation
  resolvedAt?: number;      // unix ms
  status: "pending" | "resolved" | "timed_out" | "rejected";
};
```

Obligation lifecycle:

1. **Register**: when a `pending` verdict is composed, the kernel registers all declared obligations with the obligation tracker.
2. **Track**: the operation remains paused. The kernel does not re-evaluate policies until all obligations are resolved or one times out.
3. **Resolve**: an authorized actor resolves the obligation. The kernel re-evaluates the original request with the resolved obligation facts added to `contextSnapshot`.
4. **Timeout**: if `timeoutMs` elapses without resolution, the obligation is marked `timed_out` and the operation is treated as denied. A `run.abort` effect is applied and an `audit.annotate` diagnostic is emitted.

Maximum obligation wait time is 24 hours (`86_400_000 ms`). Obligations that exceed this limit are automatically timed out by the kernel.

Obligations may not be resolved by the same actor that initiated the governed operation unless the actor has explicit `obligation.self_resolve` permission.

## Execution Semantics

```text
S -- request(operation) -->
  build PolicyRequest
  validate point contract
  evaluate policies
  compose decisions
  validate effects against point
  if deny: apply safe effects, block operation
  if pending: apply safe effects, pause operation with obligations
  if allow: apply pre-effects, execute operation, evaluate post point, apply post-effects
  S'
```

Post points never authorize side effects that already happened. They may audit, redact output, apply compensation effects, update memory, or shape writeback according to the point contract.

## Required Governance Coverage

### Worker

- `worker.spawn`
- `worker.assign`
- `worker.resume`
- `worker.cancel`
- `worker.ipc.send`
- `credential.inject`

### Skill

- `skill.resolve`
- `skill.load`
- `skill.activate`
- `skill.resource.read`
- `skill.mcp.enable`

### MCP

- `mcp.connect`
- `mcp.disconnect`
- `mcp.tool.call`
- `mcp.resource.read`
- `mcp.prompt.get`
- `mcp.auth.use`

### Subagent and Background Work

- `subagent.spawn`
- `subagent.send`
- `subagent.resume`
- `subagent.cancel`
- `subagent.wait`
- `background.launch`
- `background.output`
- `background.cancel`

### Core Execution

- `llm.generate`
- `tool.invoke`
- `session.write`
- `artifact.write`
- `memory.read`
- `memory.write`
- `writeback.commit`

## PolicyPoint Contract Registry

Each policy point is a versioned ABI contract. The table below defines the full contract for each point: allowed effects, required context fields, default fail policy, side-effect boundary, and phase.

| Point ID | Allowed Effects | Required Context | Default Fail Policy | Side-Effect Boundary | Phase |
| --- | --- | --- | --- | --- | --- |
| `session.inbound.pre` | `audit.annotate`, `run.abort`, `delegation.set_constraints` | `actorId`, `sessionId`, `inboundEvent` | `fail-closed` | yes | pre |
| `run.lifecycle.pre` | `audit.annotate`, `run.abort`, `delegation.set_constraints`, `prompt.append_context`, `prompt.inject_message` | `actorId`, `sessionId`, `runId` | `fail-closed` | yes | pre |
| `run.turn.pre` | `audit.annotate`, `run.abort`, `run.retry_after`, `prompt.append_context`, `prompt.inject_message` | `sessionId`, `runId`, `turnIndex` | `fail-closed` | yes | pre |
| `prompt.context.pre` | `prompt.append_context`, `prompt.inject_message`, `prompt.replace`, `audit.annotate` | `sessionId`, `runId`, `turnIndex` | `fail-open` | yes | pre |
| `tool.catalog.pre` | `tool.filter`, `audit.annotate`, `run.abort` | `sessionId`, `runId`, `availableTools` | `fail-closed` | yes | pre |
| `connection.llm.pre` | `prompt.append_context`, `prompt.inject_message`, `run.abort`, `audit.annotate` | `sessionId`, `runId`, `modelId` | `fail-closed` | yes | pre |
| `connection.llm.post` | `audit.annotate`, `run.abort`, `prompt.inject_message`, `run.replace_messages` | `sessionId`, `runId`, `modelId`, `responseTokens` | `fail-open` | no | post |
| `tool.native.pre` | `tool.filter`, `tool.rewrite_input`, `tool.skip_invocation`, `tool.require_approval`, `run.abort`, `audit.annotate` | `sessionId`, `runId`, `toolId`, `toolInput` | `fail-closed` | yes | pre |
| `tool.mcp.pre` | `tool.filter`, `tool.rewrite_input`, `tool.skip_invocation`, `tool.require_approval`, `run.abort`, `audit.annotate` | `sessionId`, `runId`, `toolId`, `mcpServerId`, `toolInput` | `fail-closed` | yes | pre |
| `delegation.subagent.pre` | `delegation.set_constraints`, `delegation.require_approval`, `run.abort`, `audit.annotate` | `sessionId`, `runId`, `subagentId`, `subagentProfile` | `fail-closed` | yes | pre |
| `delegation.background.pre` | `delegation.set_constraints`, `delegation.require_approval`, `run.abort`, `audit.annotate` | `sessionId`, `runId`, `backgroundTaskId` | `fail-closed` | yes | pre |
| `tool.native.post` | `audit.annotate`, `run.abort`, `tool.rewrite_output` | `sessionId`, `runId`, `toolId`, `toolResult` | `fail-open` | no | post |
| `tool.mcp.post` | `audit.annotate`, `run.abort`, `tool.rewrite_output` | `sessionId`, `runId`, `toolId`, `mcpServerId`, `toolResult` | `fail-open` | no | post |
| `delegation.subagent.post` | `audit.annotate` | `sessionId`, `runId`, `subagentId`, `subagentResult` | `fail-open` | no | post |
| `delegation.background.post` | `audit.annotate` | `sessionId`, `runId`, `backgroundTaskId`, `taskResult` | `fail-open` | no | post |
| `run.turn.post` | `audit.annotate`, `run.abort`, `run.continue_with_prompt`, `prompt.inject_message`, `run.replace_messages` | `sessionId`, `runId`, `turnIndex`, `turnResult` | `fail-open` | no | post |
| `run.completion.pre` | `audit.annotate`, `run.abort`, `prompt.append_context`, `run.replace_messages` | `sessionId`, `runId`, `completionCandidate` | `fail-closed` | yes | pre |
| `session.writeback.pre` | `audit.annotate`, `run.abort`, `writeback.rewrite`, `writeback.suppress` | `sessionId`, `runId`, `writebackPayload` | `fail-closed` | yes | pre |
| `run.lifecycle.post` | `audit.annotate` | `sessionId`, `runId`, `runOutcome` | `fail-open` | no | post |
| `run.error.error` | `audit.annotate`, `run.abort`, `run.retry_after` | `sessionId`, `runId`, `errorCode`, `errorPhase` | `fail-closed` | no | error |

## Required Policy Points

Policy points use a 3-tier ID scheme: `{tier1}.{tier2}.{tier3}`.

- **Tier 1** (resource domain): `tool`, `prompt`, `delegation`, `session`, `credential`, `connection`, `run`
- **Tier 2** (resource subtype): `native`, `mcp`, `context`, `catalog`, `subagent`, `background`, `inbound`, `writeback`, `llm`, `turn`, `completion`, `lifecycle`, `error`
- **Tier 3** (lifecycle phase): `pre`, `post`, `error`

The 14 legacy timing names map to 3-tier IDs as follows:

| Legacy Timing | 3-Tier Point ID(s) | Notes |
| --- | --- | --- |
| `inbound.receive` | `session.inbound.pre` | 1:1 |
| `run.start` | `run.lifecycle.pre` | 1:1 |
| `turn.start` | `run.turn.pre` | 1:1 |
| `context.prepare` | `prompt.context.pre` | 1:1 |
| `resources.prepare` | `tool.catalog.pre` | 1:1 |
| `model.request` | `connection.llm.pre` | 1:1 |
| `model.response` | `connection.llm.post` | 1:1 |
| `invoke.prepare` | `tool.native.pre`, `tool.mcp.pre`, `delegation.subagent.pre`, `delegation.background.pre` | 1:N — split by resource kind |
| `invoke.result` | `tool.native.post`, `tool.mcp.post`, `delegation.subagent.post`, `delegation.background.post` | 1:N — split by resource kind |
| `turn.finish` | `run.turn.post` | 1:1 |
| `completion.prepare` | `run.completion.pre` | 1:1 |
| `writeback.commit` | `session.writeback.pre` | 1:1 |
| `run.finish` | `run.lifecycle.post` | 1:1 |
| `error` | `run.error.error` | 1:1 |

The `invoke.prepare` and `invoke.result` timings expand to multiple 3-tier points because native tools, MCP tools, subagents, and background tasks have different allowed effects and required context fields. The legacy timing remains valid as a routing alias during migration; the kernel resolves it to the appropriate 3-tier point based on the resource kind in the `PolicyRequest`.

Additional resource-specific point IDs may be introduced when the lifecycle point is too broad, but they must map back to one of the lifecycle phases for observability.

## Runtime Ownership

- `protocol` owns schemas: `PolicyPoint`, `PolicyRequest`, `PolicyDecision`, `PolicyEffect`, `RuntimeResource.Descriptor`.
- `agent` owns the pure evaluator, decision composition, and stateless point adapters for ChatAgent execution.
- `openomni` owns session-backed resource descriptors and policy-aware facades for ingress, subagents, background work, tools, skills, and writeback.
- `coordinator` owns worker process policy points, worker bootstrap validation, IPC dispatch gating, recovery, and credential injection mediation.
- `server` owns host-specific MCP lifecycle gates, channel actor descriptors, and context source descriptors.

## Canonical Decision Contract

Policy functions return `PolicyDecision` directly:

- `allow` permits the boundary and may contribute compatible effects;
- `deny` blocks fail-closed pre-boundaries and remains diagnostic-only at configured post-boundaries;
- `pending` blocks until an obligation such as approval is satisfied.

Runtime behavior changes are expressed as typed effects such as `prompt.inject_message`, `prompt.append_context`, `tool.filter`, `tool.rewrite_input`, `tool.rewrite_output`, `tool.skip_invocation`, `run.abort`, `run.continue_with_prompt`, `run.replace_messages`, `writeback.rewrite`, `writeback.suppress`, and `delegation.set_constraints`. Effects not allowed by the resolved policy point fail closed at pre-boundaries.

## No-bypass Rule

Public runtime APIs must converge on policy-aware facades.

Forbidden patterns:

- calling MCP clients directly for governed tool calls;
- dispatching workers without request validation;
- spawning subagents or background tasks without a resource descriptor;
- injecting skills into context without source and activation policy;
- writing session-visible output without `writeback.commit`;
- injecting credentials outside a credential policy point.

Raw clients may exist internally only behind a facade that constructs a `PolicyRequest` before side effects occur.

## Versioning

The kernel exposes:

- `policyKernelVersion`;
- `PolicyPoint.version`;
- `RuntimeResource.schemaVersion`;
- `PolicyEffect.version` for effect types that need independent evolution.

Old decision fixtures must replay successfully or fail with an explicit migration error. Silent reinterpretation is forbidden.

## Conformance Tests

Minimum required test matrix:

| Area | Required coverage |
| --- | --- |
| Composition | allow, deny, pending precedence; effect ordering; conflict handling |
| Determinism | same request snapshot and policy set produce the same effective decision |
| No bypass | worker, skill, MCP, subagent, tool, LLM, session write paths cannot execute through raw clients |
| Resource descriptors | validate, serialize, hash, and redact every resource kind |
| Versioning | old fixtures replay or fail with explicit migration errors |
| Effect executor | disallowed effect rejection and deterministic failure behavior |
| Integration | real worker spawn, MCP call, skill load, subagent spawn, and writeback pass through policy |
| Security | malicious labels, secret leakage, path traversal, untrusted MCP metadata, forged descriptors |

## Error Point Semantics

The `run.error.error` point fires when an unhandled error occurs during a governed operation. It is not a pre-boundary point: the side effect may or may not have occurred.

Error point contract:

- **Allowed effects**: `audit.annotate`, `run.abort`, `run.retry_after`.
- **Required context**: `sessionId`, `runId`, `errorCode`, `errorPhase` (the 3-tier point ID where the error originated), `errorMessage`.
- **Default fail policy**: `fail-closed`. If the error point itself fails to evaluate, the run aborts.
- **Retry semantics**: `run.retry_after` at the error point schedules a retry of the failed operation, not the entire run. The retry counter is per-operation, not per-run.
- **Retry max count**: default 3. A policy may lower this limit via `run.retry_after.maxRetries`. The kernel never retries beyond the effective maximum regardless of policy output.
- **Abort behavior**: if any policy at the error point returns `run.abort`, the run terminates immediately. No further retry is attempted. An `audit.annotate` diagnostic is emitted with the abort reason.
- **Diagnostic effect allowlist**: at the error point, only `audit.annotate` and `run.abort` and `run.retry_after` are allowed. Prompt-shaping and tool-shaping effects are not permitted because the error context is not a safe prompt boundary.

Error points do not re-authorize the original operation. They only decide whether to retry, abort, or annotate.

## Edge Cases

### Retry Max Count

The default retry maximum is 3 attempts per governed operation. This applies to `run.retry_after` effects at both normal policy points and the error point. The kernel tracks retry count per `(runId, operationId)` pair. When the maximum is reached, the kernel treats the next failure as a terminal abort and emits an `audit.annotate` with reason `retry_limit_exceeded`.

A policy may set a lower maximum via `run.retry_after.maxRetries`. The effective maximum is `min(policy.maxRetries, kernel.defaultMaxRetries)`. A policy may not raise the maximum above the kernel default.

### Parallel Tool Deny

When multiple tools are evaluated in parallel and one is denied, only the denied tool is blocked. Other tools in the same parallel batch continue to execute unless their own policy evaluation also returns deny. The kernel does not propagate a single tool deny to the entire parallel batch.

If a denied tool's output is a required input for another tool in the same batch, the dependent tool receives a `tool_denied` error result. The error point fires for the dependent tool with `errorPhase` set to the pre-boundary point of the denied dependency.

### Policy Evaluation Exception Handling

If a policy function throws an exception during evaluation:

- **At a pre-boundary point**: the kernel treats the exception as a deny. The operation is blocked. An `audit.annotate` diagnostic is emitted with the exception details. This is fail-closed behavior.
- **At a post-boundary point**: the kernel treats the exception as a non-fatal diagnostic. The operation result is not retroactively denied. An `audit.annotate` diagnostic is emitted. This is fail-open behavior.
- **At the error point**: the kernel treats the exception as a terminal abort. The run terminates. An `audit.annotate` diagnostic is emitted.

Policy exceptions are never silently swallowed. Every exception produces at least one `audit.annotate` effect.

### Descriptor Validation Failure

If a `RuntimeResource.Descriptor` fails schema validation before a policy point fires, the kernel treats this as a pre-boundary deny. The operation is blocked and an `audit.annotate` diagnostic is emitted with reason `descriptor_invalid`. This prevents ungoverned operations from proceeding with malformed resource identity.

### Unknown Point ID

If a `PolicyRequest` arrives with a point ID that is not registered in the kernel's point registry, the kernel rejects the request with a `point_unknown` error. The operation is blocked. This prevents ad-hoc point IDs from bypassing the contract registry.

## Implementation Sequence

1. Freeze this specification and ADR.
2. Make canonical PolicyDecision dispatch total: no silent allow, deny is terminal, unsupported decision shapes fail closed at pre-boundary points.
3. Introduce a runtime `PolicyPoint` registry for the existing 14 timing points.
4. Attach `RuntimeResource.Descriptor` to tool catalog entries first, then MCP, subagents, skills, workers, credentials, and session writes.
5. Introduce `PolicyDecision` with `effects[]` behind a compatibility adapter.
6. Convert high-risk policies first: tool permission, ingress authority, subagent/background limits, MCP prefix guard, worker bootstrap, credential injection.
7. Convert prompt-shaping policies after the safety boundary is stable: memory, skills, compaction, post-turn, persistence enforcement.
8. Keep legacy verdict support removed. Current conformance tests must cover every governed operation that is wired in this implementation; paths listed in the appendix remain explicitly skipped until their policy-aware facades are introduced.

## Appendix: Known Ungoverned Paths

These paths bypass the policy kernel today. Each is documented as a skipped test in `packages/agent/test/core/policy/conformance/no-bypass.test.ts`. They are not bugs in the current implementation — the kernel is not yet wired to these call sites. They are tracked here so the v2 integration sequence is explicit and auditable.

### 1. Direct MCP client

**Location**: `packages/agent/src/runtime/mcp/client.ts` — `McpClient.callTool()`

**Gap**: `callTool()` sends the MCP request directly to the remote server without constructing a `PolicyRequest` or passing through a `tool.mcp.pre` point. Any policy registered at `invoke.prepare` or `tool.mcp.pre` is not consulted.

**Spec requirement**: `tool.mcp.pre` must gate every remote MCP tool call before the network side effect occurs (see Required Governance Coverage — MCP).

**v2 integration**: Wrap `callTool()` in a facade that builds a `RuntimeResource.Descriptor` with `kind: "tool"` and `source.type: "mcp"`, then dispatches `tool.mcp.pre` before forwarding to the raw client. The facade lives in `packages/agent/src/runtime/mcp/` and is the only public call site.

---

### 2. Worker spawn

**Location**: `packages/coordinator/src/worker-pool/supervisor.ts` — `doStart()`

**Gap**: `doStart()` forks the worker process without a policy check. No `worker.spawn` point fires before the process is created.

**Spec requirement**: `worker.spawn` must gate every worker process creation (see Required Governance Coverage — Worker).

**v2 integration**: `coordinator` owns worker process policy points per the Runtime Ownership section. A `worker.spawn` pre-boundary check must be inserted in `doStart()` before the fork, using a `RuntimeResource.Descriptor` with `kind: "worker"`.

---

### 3. Worker IPC dispatch

**Location**: `packages/coordinator/src/ipc/server.ts`

**Gap**: Inbound IPC messages are dispatched to handlers without a `worker.ipc.send` policy check. Any message arriving on the Unix socket is processed immediately.

**Spec requirement**: `worker.ipc.send` must gate IPC dispatch (see Required Governance Coverage — Worker).

**v2 integration**: The IPC server should construct a `PolicyRequest` from the envelope actor and session context before routing to the handler. The `coordinator` package owns this gate.

---

### 4. Credential injection

**Location**: `packages/coordinator/src/credentials/injector.ts`

**Gap**: Credentials are injected into worker environments without a `credential.inject` policy check. No policy can deny or audit credential delivery.

**Spec requirement**: `credential.inject` must gate every credential injection (see Required Governance Coverage — Worker).

**v2 integration**: The injector must dispatch `credential.inject` pre-boundary before writing credentials into the worker environment. The `RuntimeResource.Descriptor` should use `kind: "credential"` with the credential id and source metadata. Secrets must not appear in the descriptor.

---

### 5. Tool permission (partial)

**Location**: `packages/coordinator/src/tool-permission/policy.ts`

**Gap**: A tool permission policy exists in the coordinator but it is not wired to the v2 `PolicyEngine` or the `tool.native.pre` / `tool.mcp.pre` points. It operates as a standalone check disconnected from the composed decision pipeline.

**Spec requirement**: Tool permission enforcement must flow through the canonical policy composition path so deny verdicts are absorbing and audit effects are emitted consistently.

**v2 integration**: The coordinator tool permission policy should be registered as a `PolicyRegistration` at `tool.native.pre` (and `tool.mcp.pre` for MCP tools) so it participates in the standard composition and audit pipeline.

---

### 6. Direct LLM run

**Location**: `packages/llm/src/run.ts`

**Gap**: `run()` calls the LLM provider directly without a `connection.llm.pre` policy check. The agent-mediated path through `StreamEngine` does dispatch `model.request`, but callers that import `run()` directly bypass it entirely.

**Spec requirement**: `connection.llm.pre` must gate every LLM generation request (see Required Governance Coverage — Core Execution).

**v2 integration**: Direct callers of `packages/llm/src/run.ts` should be audited and migrated to go through `StreamEngine` or a policy-aware facade. The `llm` package itself should not own the policy check — the boundary belongs in the agent or openomni layer that constructs the `PolicyRequest`.

---

### 7. Session direct writes

**Location**: `packages/session/src/session/index.ts` — `Session.addMessage()`, `Session.addPart()`

**Gap**: Session write methods accept data and persist it without a `session.write` policy check. Any caller can write to a session without policy mediation.

**Spec requirement**: `session.write` must gate session-visible output mutations (see Required Governance Coverage — Core Execution).

**v2 integration**: Session writes that originate from governed operations should go through a policy-aware facade in `packages/openomni` rather than calling `Session.addMessage()` directly. The `session` package remains a raw storage layer; the governance boundary lives one layer up.

---

### 8. Artifact writes

**Location**: `packages/session/src/artifact/index.ts` — `Artifact.store()`

**Gap**: `Artifact.store()` persists artifact data without an `artifact.write` policy check. Artifacts can be written from any call site without policy mediation.

**Spec requirement**: `artifact.write` is a governed side effect under Core Execution coverage.

**v2 integration**: Same pattern as session writes. Artifact storage that originates from governed operations should route through a policy-aware facade in `packages/openomni`. The `session` package stays as raw storage.

---

### 9. Todo writes

**Location**: `packages/session/src/todo/index.ts` — `Todo.update()`

**Gap**: `Todo.update()` mutates todo state without a policy check. Todo mutations are session-visible side effects with no governance gate.

**Spec requirement**: Todo writes are session-visible mutations and fall under the `session.write` governance requirement.

**v2 integration**: Same pattern as session and artifact writes. Governed callers should route through a policy-aware facade. The `session` package stays as raw storage.

---

### 10. Skill load and activation

**Location**: `packages/openomni/src/skill/index.ts` — `SkillLoader.discover()`, `SkillLoader.load()`

**Gap**: Skill discovery and loading do not dispatch `skill.resolve`, `skill.load`, or `skill.activate` policy points. Skills are loaded and injected into agent context without authorization.

**Spec requirement**: `skill.resolve`, `skill.load`, and `skill.activate` must gate skill lifecycle operations (see Required Governance Coverage — Skill).

**v2 integration**: `SkillLoader` should dispatch `skill.resolve` before resolving a skill path, `skill.load` before reading skill content, and `skill.activate` before injecting the skill into an agent's context. `RuntimeResource.Descriptor` with `kind: "skill"` and appropriate source labels is already defined in the descriptor helpers.

---

### Integration Priority

The no-bypass rule (see No-bypass Rule section) requires these ten paths to become enforced before they are exposed through policy-aware facades. They remain documented skipped conformance gaps in the current implementation. The recommended order follows the Implementation Sequence:

1. Worker spawn and IPC dispatch (coordinator owns these; high blast radius if ungoverned)
2. Credential injection (security-critical; no policy audit today)
3. Direct MCP client (external network side effect; `tool.mcp.pre` already specified)
4. Skill load and activation (behavior injection; `skill.activate` already specified)
5. Tool permission wiring (coordinator policy already exists; needs v2 registration)
6. Session, artifact, and todo writes (facade pattern; lower urgency than network/process paths)
7. Direct LLM run (audit callers; migrate to agent-mediated path)
