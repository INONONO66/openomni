# ADR-007: Policy Kernel v2 as Resource/Effect Governance VM

**Status**: Proposed

## Context

OpenOmni already has a policy engine with lifecycle timings and middleware-style verdicts. That engine is useful for current agent behavior, but it is not sufficient as the permanent governance core for a persona workforce runtime.

The long-term runtime must mediate tools, MCP servers, skills, workers, subagents, credentials, LLM calls, session writes, and writeback. These operations are not equivalent to prompt hooks. They are capability and side-effect boundaries. If any of them can execute through raw clients or ad-hoc guards, the system has no single authority model and no reliable audit story.

The product philosophy says structure determines behavior. Governance therefore needs to be a stable runtime structure, not an instruction convention. The desired bar is closer to an interpreter kernel than a callback list: stable semantics, explicit contracts, deterministic composition, versioned ABI, and conformance tests.

## Decision

OpenOmni will define **Policy Kernel v2** as a resource/effect governance VM.

The kernel is specified in [Policy Kernel v2 Specification](../policy-kernel-spec.md). The key model is:

- `PolicyPoint` is a versioned ABI contract for a governance boundary. Points are identified by a **3-tier ID scheme**: `{tier1}.{tier2}.{tier3}`, where tier 1 is the resource domain (`tool`, `prompt`, `delegation`, `session`, `credential`, `connection`, `run`), tier 2 is the resource subtype, and tier 3 is the lifecycle phase (`pre`, `post`, `error`). This 3-tier scheme is the primary point identification model going forward.
- `RuntimeResource.Descriptor` is the canonical identity for governed tools, skills, MCP resources, workers, credentials, sessions, and other runtime capabilities. All tools share `kind: "tool"` and are distinguished by `source.type` (`system`, `mcp`, `skill`). This unified kind model keeps policy evaluation consistent across tool origins while preserving per-source routing.
- `PolicyRequest` is a deterministic snapshot passed into policy evaluation. It includes an `ActorDescriptor` (who is initiating the operation) and an optional `SessionDescriptor` (session context, including `sessionType` for root/child/self-loop classification).
- `PolicyDecision` is a declarative result containing a verdict and `effects[]`.
- `PolicyEffect` is data interpreted by trusted point adapters, not executable policy code.
- Side-effecting runtime APIs must converge on policy-aware facades.

Legacy `Policy.Verdict` remains a migration input only. It must be adapted into `PolicyDecision` semantics and cannot be allowed to silently fall through at side-effect boundaries.

### Audit Decision

Policy decisions are observable events. Every governed operation emits a Bus event carrying the `PolicyRequest` snapshot, the composed `PolicyDecision`, and applied effects. Bus events follow the `BusEvent.define()` pattern and are persisted through `BusPersistence`. This makes policy decisions replayable and auditable without requiring a separate audit store.

The `audit.annotate` effect is the primary mechanism for policies to attach structured metadata to the Bus event. Deny and pending verdicts always emit an audit annotation with reason codes.

## Rationale

- **Total mediation**: a governance kernel is only meaningful if every governed side effect passes through it before execution.
- **Stable authority model**: policy decisions should be made against canonical resource descriptors, not inconsistent tool names or call-site-specific metadata.
- **3-tier point IDs**: the `{tier1}.{tier2}.{tier3}` scheme makes the resource domain, subtype, and lifecycle phase explicit in the point name. This eliminates ambiguity in the legacy flat timing names and enables per-resource-kind effect contracts. The `invoke.prepare` timing, for example, maps 1:N to `tool.native.pre`, `tool.mcp.pre`, `delegation.subagent.pre`, and `delegation.background.pre` because each has different allowed effects and required context.
- **Unified tool kind with source subdivision**: using `kind: "tool"` for all tool resources and `source.type` for origin (`system`, `mcp`, `skill`) keeps the policy evaluation path uniform. Policies that apply to all tools use the kind; policies that apply only to MCP tools filter on `source.type`.
- **Determinism and replay**: policy evaluation must be based on request snapshots so decisions can be audited and replayed.
- **Composable behavior**: effect arrays allow multiple policies to contribute compatible outcomes while preserving deny dominance.
- **Interpreter-grade evolution**: versioned points and conformance fixtures make future changes explicit instead of silently changing behavior.
- **Persona safety**: Main/Sub Persona authority, skill composition, MCP access, and worker delegation all need the same structural control plane.

## Consequences

- The current middleware-style `PolicyEngine.dispatch()` must be hardened before effect-based composition is enabled.
- Every lifecycle point needs a contract: allowed effects, required context, default fail policy, and side-effect boundary semantics. The 3-tier point registry in the spec is the authoritative contract table.
- Tools, MCP tools, skills, subagents, workers, credentials, and session writes need `RuntimeResource.Descriptor` coverage.
- Existing ad-hoc runtime guards must either become policies or sit behind policy-aware facades.
- The conformance test suite becomes part of the kernel contract, not just implementation regression coverage.
- Documentation and package maps must distinguish the legacy verdict adapter from the long-term effect-based kernel.
- Bus event integration for policy audit requires `BusPersistence` to handle policy decision events without performance regression on the hot path.

## Non-goals

- This decision does not require a disruptive one-shot rewrite of all existing policies.
- This decision does not let policy functions directly mutate runtime state or call external services.
- This decision does not move session ownership into `agent`; session-backed orchestration remains in `openomni`.
- This decision does not make every MCP server or skill trusted by default.

## Migration Strategy

1. Freeze the kernel specification and conformance expectations.
2. Make legacy verdict dispatch total: deny is terminal, unsupported verdicts are explicit errors, and pre-boundary failures fail closed.
3. Add a runtime `PolicyPoint` registry for the current 14 lifecycle timings. Register each timing under its 3-tier ID. The legacy flat timing names remain valid as routing aliases during this step; the kernel resolves them to the appropriate 3-tier point based on the resource kind in the `PolicyRequest`.
4. Attach `RuntimeResource.Descriptor` to tool catalog entries, then expand to MCP, skills, subagents, workers, credentials, and session writes. Set `source.type` on all tool descriptors at this step.
5. Introduce `PolicyDecision` and effect composition behind a compatibility adapter.
6. Convert high-risk policies first: tool permission, ingress authority, subagent/background limits, MCP prefix guard, worker bootstrap validation, and credential injection.
7. Convert prompt-shaping and persistence policies after side-effect boundaries are safe.
8. Remove legacy verdict support only when conformance tests cover every governed operation.
