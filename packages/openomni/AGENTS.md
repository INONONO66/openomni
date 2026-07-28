# packages/openomni

Product kernel for OpenOmni. Builds on `@openomni/agent`, `@openomni/policy`, `@openomni/session`, and `@openomni/protocol` to own messaging/routing, access control, Resident/Worker orchestration, ledger/evidence gates, dispatch, and worker execution tooling. Lower packages provide primitives; this package decides product meaning.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/agents/` | Built-in agent definitions and model-specific prompt variants | `ResidentAgent` |
| `src/resident/` | Resident runtime lifecycle (in-process execution, direct mode) | `ResidentRuntime` |
| `src/ingress/` | Current inbound stage: single kernel route resolution, authority facts, projection, resident/direct execution | `IngressEngine`, `resolveRoute`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge`, `CronAdapter`, `resolveTarget`, `targetKey` |
| `src/dispatch/` | Current egress/cross-boundary stage: command authorization, Wait routing, gate-side policy stamping | `DispatchRuntime`, `DispatchRegistry`, `createDefaultDispatchRuntime` (+ `BuiltInDispatchOptions.policyResolver`) |
| `src/policy/` | Gate-side policy resolution: actor/target labels → stamped `policyPlan` on spawn requests (production-wired by #479) | `PolicyResolver` |
| `src/evidence/` | Read-back executors plus unconsumed verifier/stakes foundations | `ReadBackExecutor`; unconsumed `VerifierRegistry`, `Stakes` |
| `src/execution-runtime/` | Tool/workspace/worker runtime, ledger-backed scheduling, workspace identity, and effect-scope resolution | Runtime exports, `ScheduleService`, `createWorkspaceIdentity`, `EffectScopeRegistry` |
| `src/ledger/` | Production native transition catalog, reducers, typed ports, and semantic services | `NATIVE_TRANSITION_CATALOG_R9`, transition/reducer modules, production services under `src/ledger/production/` |

## P2-04 PRODUCTION CUTOVER

- P2-04 is production-wired against the strict fresh `p2-clean-v1` baseline. OpenOmni owns native transition meaning and exposes bounded semantic services over the sole session-owned structural writer/query/projection runtime.
- Production services are split by domain under `src/ledger/production/`. They own Work/Attempt/Wait, route/dispatch, authority/configuration, schedule/effect, connector/artifact, completion, messaging/access, and recovery meaning. Consumers never receive generic append or database authority.
- The native catalog and projection catalog are closed. The checked manifest covers 143 operations and 97 native event payload schemas.
- Worker requests are authenticated and bound to their active runtime, principal, session, run, and Attempt before semantic transition/query access. Credential provisioning is private, provider-scoped, and requires a post-provisioning acknowledgement before execution.
- Resident and Worker execution use an explicit validated LLM environment and credential binding. No ambient model selection or unknown-agent substitution is permitted.
- `VerifierRegistry` and `Stakes` remain unconsumed foundations; their later consumers are not implied by the P2-04 cutover.
- **P2-05–P2-07, C1, P3, and P4 remain unshipped.** P3 still owns package moves: kernel ingress/dispatch/policy/evidence/ledger meaning stays in OpenOmni while `resident/` and `agents/` move to the server host.

## Architecture

- `src/agents/` contains built-in agent definitions. `src/agents/resident/prompt/` holds the Resident system prompt with model-specific variants (Claude, GPT) and a shared builder. `ResidentAgent.getPrompt({ model })` selects the right variant by provider.
- `src/resident/` provides `ResidentRuntime` for in-process Resident execution without coordinator dispatch.
- `src/ingress/` uses the shipped single kernel `resolveRoute` pipeline (#464, PR #485) for inbound precedence and decision ownership. Separately, the future P3 package plan (#456) keeps `ingress/`, `dispatch/`, `policy/`, `evidence/`, and the cron/injection parts of `execution-runtime/` in the kernel while moving `resident/` and `agents/` to `apps/server`. OpenOmni currently owns principal-resolution handoff, access checks, correlation, session/target resolution, projection, writeback, and response routing; #456 changes package placement, not that product ownership.
- `src/ingress/` resolves identity, access, native Wait correlation, session, target, and execution path, then commits route/message facts through production semantic services before selected execution. Internal schedule fire enters through the same kernel surface.
- `src/dispatch/` is the cross-boundary command stage. It authorizes commands, routes Wait replies, invokes handlers, and commits audit/lifecycle facts through semantic services. Treat dispatch as a kernel stage, not a standalone product layer.
- `src/execution-runtime/tool/agent/tools/dispatch.ts` is the `dispatch` tool — the runtime-to-runtime/system egress gate. Worker-to-Resident awaited requests use `resident.ask`; scheduling uses `schedule.create`; cron fire remains internal ingress. `Dispatch.submit()` enforces PolicyEngine authorization and emits Bus audit events. See `src/dispatch/` for the runtime, handlers, and policy.
- `src/execution-runtime/injection-queue.ts` (`InjectionQueue`) holds async responses keyed by `runId`. The worker middleware drains the queue at `turn.finish` and injects pending responses into the agent's next turn.
- `src/execution-runtime/schedule-service.ts` provides the ledger-backed semantic schedule seam. `CronJobRunner` scans projected schedules; create, cancel, fire, generation advance, and effect settlement commit through native transitions. There is no process-local schedule authority or storage-adapter fallback.
- Dispatch Worker allocation and ingress session creation require the explicit validated model environment and credential binding before state creation. The LLM catalog cache is derived and never authorizes model selection.
- Do not create aspirational domain folders. Future package moves and renames are owned by #456 (P3 disposition map); the #464 `resolveRoute` consolidation is already shipped and is not a prerequisite for those moves.
- Resident/Worker orchestration seams, controlled inbound access, self-loop session creation, Worker delegation, durable external waits, ledger/evidence gates, and distilled writeback all belong in this package.
- P2-04 production services are the only durable lifecycle convention. Do not bypass them with direct storage, generic append, or Bus-observer state.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Kernel Design Rules

- Messaging/access semantics live here. If a change decides target, session, run, principal, trust, grant, pending correlation, writeback, or response routing, implement it in `openomni`.
- `ingress/` and `dispatch/` are implementation stages. New cross-boundary routing must not add another server-side or tool-side special case — use the shipped kernel `resolveRoute` pipeline (#464) and the existing dispatch stage.
- Do not let `apps/server` inspect durable routing/configuration state directly. Server passes normalized facts and injected host dependencies; OpenOmni decides.
- Do not let `packages/session` decide authority or match precedence. It may store and query records; OpenOmni owns lifecycle transitions that have product meaning.
- Do not let `packages/coordinator` decide actor/session authority. It executes primitive worker-process operations requested by this package.
- Do not let `packages/agent` grow OpenOmni-specific durable lifecycle. Session-backed worker/background orchestration stays here.
- The Resident never receives `child_agent`. Only Worker processes may use same-domain, context-sharing subagents.
- A Worker never commissions or spawns another Worker, even when a stale/misconfigured WorkerGrant names `worker.spawn`. Cross-domain work goes through an existing-agent message or `resident.ask`; the Resident allocates new Worker work.
- Policy is a system-wide interception plane, not a Worker subsystem. Resident and every other actor profile may select registrations across the shared run/prompt/tool/LLM/writeback points.
- Existing-agent messages target an already allocated actor/session and never allocate Work, a Worker, executor, or budget. Awaited `resident.ask` uses the native durable Wait lifecycle; generic existing-agent messaging and partial/N-of-M response semantics remain unshipped under #215.
- Jester output has no authority. The kernel-owned host records the silence-or-challenge result and independently decides whether authorized egress may proceed through policy, stakes/budget, Voice, and `dispatch.submit`; `bus.publish` remains observation-only. The canonical role and lifecycle boundaries live in [`../../docs/core-model.md`](../../docs/core-model.md) and [`../../docs/kernel-contract.md`](../../docs/kernel-contract.md), while [`../../docs/implementation-status.md`](../../docs/implementation-status.md) says what is wired.

## Internal Ownership Split

Use these ownership boundaries when adding or moving code:

| Area | Owns | Does not own |
| --- | --- | --- |
| Messaging | Canonical inbound/internal/outbound envelope entry, correlation, target/session resolution, response/writeback routing | Raw channel adapters, provider SDKs, worker process mechanics |
| Access | Principal facts, blocklist/channel access/trust tier/delegation grant/effective access, Wait scope | Structural persistence, raw webhook verification |
| Orchestration | Resident runtime, Worker orchestration, async run scheduling over semantic Work/Attempt services | Generic ChatAgent loop internals, process supervision |
| Ledger | Native transition meaning, production semantic services, completion/read-back admission | SQLite append/query/projection mechanics |
| Tools | Tool providers, tool executor, workspace lock, injection queue, schedule bridge | Actor/session routing policy |
| Projection | Interpretation and distilled writeback over structural projections | Transport delivery or projection persistence mechanics |

## Dependency Shape

```
agents/             → @openomni/protocol (Model.Ref only)
resident/           → @openomni/session + @openomni/agent + @openomni/protocol
policy/             → @openomni/protocol (pure label→plan resolution; consumed by dispatch)
ledger/production/  → session structural ports + protocol contracts; domain semantic services never expose generic append
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → resident/ (type-only)
dispatch/           → policy/ (resolver), ingress/ (type-only) — the gate stays the sole author of stamped plans
```

`src/index.ts` re-exports the public surface — use the package barrel instead of deep imports from consumer code.

## Public Surface

Consumers should only use `@openomni/openomni` exports:

- Resident agent prompts from `src/agents/`
- Resident runtime from `src/resident/`
- Messaging/ingress/dispatch kernel entry points from `src/ingress` and `src/dispatch`

- Tool system, workspace lock, worker middleware, and cron runtime from `src/execution-runtime/`

If a symbol is not re-exported from `src/index.ts`, treat it as private to its domain.

## Extension Points

- Add new tools or tool providers in `src/execution-runtime/tool/` following the `ToolProvider` interface; tools should call kernel entry points instead of making routing decisions.
- Add new messaging flows through the existing `src/ingress/` / `src/dispatch/` stages and the shipped #464 `resolveRoute` pipeline.
- Add Resident/Worker orchestration here when implementing product model contracts: authority checks, self-loop creation, worker delegation, external waits, and distilled writeback are kernel responsibilities.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the structural ledger package. Use `@openomni/session` for the single writer, bounded queries, closed synchronous projections, blobs, and observation Bus. Keep product transition and access meaning here.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core or generic agent-loop primitives.
- It is not the owner of provider-specific connector installation UX. The server hosts provider-neutral process/credential transport; installation discovery and UX remain unshipped.

## Domain Docs

- `src/ledger/production/` contains production semantic service modules; keep the server composition thin and add lifecycle meaning here.
- `src/ingress/AGENTS.md` — inbound event handling and mode dispatch
- `src/execution-runtime/AGENTS.md` — tool system, workspace lock, and worker middleware

## Style Rules

See `.sisyphus/rules/modular-code-enforcement.md`. Keep package-level notes short, link to the owning domain doc, and avoid repeating API details.

## Maintenance Notes

- Update this file when a new domain folder becomes part of the package surface.
- Keep the module map aligned with `src/index.ts` exports and the domain AGENTS files.
- Prefer links to the domain docs over adding implementation detail here.
- Revisit the dependency shape when a domain starts importing a new sibling.
- When adding a public export, verify it is a real kernel contract. Internal stages and helpers should stay private until callers genuinely need the abstraction.
