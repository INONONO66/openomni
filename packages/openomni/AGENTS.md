# packages/openomni

Product kernel for OpenOmni. Builds on `@openomni/agent`, `@openomni/policy`, `@openomni/session`, and `@openomni/protocol` to own messaging/routing, access control, Resident/Worker orchestration, ledger/evidence gates, dispatch, and worker execution tooling. Lower packages provide primitives; this package decides product meaning.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/agents/` | Built-in agent definitions and model-specific prompt variants | `ResidentAgent` |
| `src/resident/` | Resident runtime lifecycle (in-process execution, direct mode) | `ResidentRuntime` |
| `src/ingress/` | Current inbound stage: single kernel route resolution, authority facts, projection, resident/direct execution | `IngressEngine`, `resolveRoute`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge`, `CronAdapter`, `resolveTarget`, `targetKey` |
| `src/dispatch/` | Current egress/cross-boundary stage: command authorization, handler routing, PendingInteraction routing, gate-side policy stamping (#479) | `DispatchRuntime`, `DispatchRegistry`, `createDefaultDispatchRuntime` (+ `BuiltInDispatchOptions.policyResolver`), `DEFAULT_DISPATCH_MODEL` |
| `src/policy/` | Gate-side policy resolution: actor/target labels → stamped `policyPlan` on spawn requests (production-wired by #479) | `PolicyResolver` |
| `src/evidence/` | Read-back executors plus scoped deterministic verifier-registry and replay-conformance primitives | `ReadBackExecutor`, `VerifierRegistry`, `VerifierConformance`, `runVerifierRegistryDriver` |
| `src/ledger/` | Dormant deterministic windowed Stakes calculator, replay driver, criterion treatment, and host capability seams | `Stakes`, `runStakesDriver` |
| `src/execution-runtime/` | Tool system, workspace, worker middleware, and scheduled job runtime | `buildWorkerMiddleware`, `WorkspaceLock`, `AgentToolProvider`, `SystemToolProvider`, `ToolProxyProvider`, `Tool`, `buildToolCatalog`, `createToolExecutor`, `defineTool`, `InjectionQueue`, `CronJobRegistry`, `CronJobRunner` |

## Architecture

- `src/agents/` contains built-in agent definitions. `src/agents/resident/prompt/` holds the Resident system prompt with model-specific variants (Claude, GPT) and a shared builder. `ResidentAgent.getPrompt({ model })` selects the right variant by provider.
- `src/resident/` provides `ResidentRuntime` for in-process Resident execution without coordinator dispatch.
- `src/ingress/` uses the shipped single kernel `resolveRoute` pipeline (#464, PR #485) for inbound precedence and decision ownership. The stable package-boundary contract keeps `ingress/`, `dispatch/`, `policy/`, `evidence/`, and the cron/injection parts of `execution-runtime/` in the kernel while `resident/` and `agents/` belong to `apps/server`. OpenOmni owns principal-resolution handoff, access checks, correlation, session/target resolution, projection, writeback, and response routing; package placement does not change that product ownership. Live P3 package work belongs to [#459](https://github.com/INONONO66/openomni/issues/459)'s leaf issues #495–#506; #496 owns the remaining IPC extraction, and #497–#500 plus #506 own the concept diet.
- `src/ingress/` is the current inbound stage. It resolves a session through `SurfaceKey`, projects the event into stored messages, then dispatches to the resident/direct handler. `ingestInternal()` accepts internal-origin events (e.g., from `CronAdapter`) without going through the external ingest path. `CronAdapter.fire(job)` creates internal events with `surface="cron"`.
- `src/dispatch/` is the current cross-boundary command stage. `DispatchRuntime.submit()` authorizes commands, routes PendingInteraction replies, invokes registered handlers, and emits audit events. Treat dispatch as a kernel stage, not as a standalone product layer.
- `src/execution-runtime/tool/agent/tools/dispatch.ts` is the `dispatch` tool — the runtime-to-runtime/system egress gate. Worker-to-Resident awaited requests use `resident.ask`; scheduling uses `schedule.create`; cron fire remains internal ingress. `Dispatch.submit()` enforces PolicyEngine authorization and emits Bus audit events. See `src/dispatch/` for the runtime, handlers, and policy.
- `src/execution-runtime/injection-queue.ts` (`InjectionQueue`) holds async responses keyed by `runId`. The worker middleware drains the queue at `turn.finish` and injects pending responses into the agent's next turn.
- `src/execution-runtime/cron-job-registry.ts` (`CronJobRegistry`) stores scheduled jobs through the session storage adapter and keeps a process-local fallback map when durable storage is absent. `src/execution-runtime/cron-job-runner.ts` (`CronJobRunner`) polls the registry and accepts an injected fire implementation; server boot wires that to `CronAdapter.fire(job)`.
- Do not create aspirational domain folders. The stable package-boundary contract above governs moves and renames; live execution is assigned to [#459](https://github.com/INONONO66/openomni/issues/459)'s P3 leaf issues. The #464 `resolveRoute` consolidation is already shipped and is not a prerequisite for package work.
- Resident/Worker orchestration seams, controlled inbound access, self-loop session creation, Worker delegation, durable external waits, ledger/evidence gates, and distilled writeback all belong in this package.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Kernel Design Rules

- Messaging/access semantics live here. If a change decides target, session, run, principal, trust, grant, pending correlation, writeback, or response routing, implement it in `openomni`.
- `ingress/` and `dispatch/` are implementation stages. New cross-boundary routing must not add another server-side or tool-side special case — use the shipped kernel `resolveRoute` pipeline (#464) and the existing dispatch stage.
- Do not let `apps/server` inspect `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WorkerGrantStore`, `ChannelGrantStore`, or `BlacklistStore` for routing. Server passes normalized facts; OpenOmni decides.
- Do not let `packages/session` decide authority or match precedence. It may store and query records; OpenOmni owns lifecycle transitions that have product meaning.
- Do not let `packages/coordinator` decide actor/session authority. It executes primitive worker-process operations requested by this package.
- Do not let `packages/agent` grow OpenOmni-specific durable lifecycle. Session-backed worker/background orchestration stays here.
- The Resident never receives `child_agent`. Only Worker processes may use same-domain, context-sharing subagents.
- A Worker never commissions or spawns another Worker, even when a stale/misconfigured WorkerGrant names `worker.spawn`. Cross-domain work goes through an existing-agent message or `resident.ask`; the Resident allocates new Worker work.
- Policy is a system-wide interception plane, not a Worker subsystem. Resident and every other actor profile may select registrations across the shared run/prompt/tool/LLM/writeback points.
- Existing-agent messages target an already allocated actor/session and never allocate a WorkItem, Worker, executor, or budget. Today Worker-to-Resident awaiting uses `resident.ask`; the target granted existing-agent path and its durable awaited `Wait` semantics belong to this kernel under #215. See [`../../docs/kernel-contract.md`](../../docs/kernel-contract.md) rather than defining Wait states here.
- Jester output has no authority. The kernel-owned host records the silence-or-challenge result and independently decides whether authorized egress may proceed through policy, stakes/budget, Voice, and `dispatch.submit`; `bus.publish` remains observation-only. The canonical role and lifecycle boundaries live in [`../../docs/core-model.md`](../../docs/core-model.md) and [`../../docs/kernel-contract.md`](../../docs/kernel-contract.md), while [`../../docs/implementation-status.md`](../../docs/implementation-status.md) says what is wired.

## Internal Ownership Split

Use these ownership boundaries when adding or moving code:

| Area | Owns | Does not own |
| --- | --- | --- |
| Messaging | Canonical inbound/internal/outbound envelope entry, correlation, target/session resolution, response/writeback routing | Raw channel adapters, provider SDKs, worker process mechanics |
| Access | Principal facts, blocklist/channel access/trust tier/delegation grant/effective access, PendingInteraction scope | Storage adapter implementation, raw webhook verification |
| Orchestration | Resident runtime, Worker orchestration, session-backed worker runtime, async run scheduling | Generic ChatAgent loop internals, provider transforms |
| Ledger | WorkItem orchestration, completion reports, read-back/verification gate execution | Low-level record storage only |
| Tools | Tool providers, tool executor, workspace lock, injection queue, schedule bridge | Actor/session routing policy |
| Projection | Session message projection, Bus audit envelopes, distilled writeback | Transport delivery |

## Dependency Shape

```
agents/             → @openomni/protocol (Model.Ref only)
resident/           → @openomni/session + @openomni/agent + @openomni/protocol
policy/             → @openomni/protocol (pure label→plan resolution; consumed by dispatch)
evidence/           → @openomni/session + @openomni/protocol (read-back → WorkItem evidence)
ledger/             → no orchestration deps (pure Stakes contracts, computation, seams, replay driver)
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → dispatch/ (DEFAULT_DISPATCH_MODEL), resident/ (type-only)
dispatch/           → policy/ (resolver), ingress/ (type-only) — the gate stays the sole author of stamped plans
```

`src/index.ts` re-exports the public surface — use the package barrel instead of deep imports from consumer code.

## Public Surface

Consumers should only use `@openomni/openomni` exports:

- Resident agent prompts from `src/agents/`
- Resident runtime from `src/resident/`
- Messaging/ingress/dispatch kernel entry points from `src/ingress` and `src/dispatch`

- Tool system, workspace lock, worker middleware, and cron runtime from `src/execution-runtime/`
- Scoped verifier-registry and replay-conformance library surfaces from `src/evidence/`; admission and archived replay stay outside these primitives
- Dormant windowed Stakes primitive and driver from the dedicated `@openomni/openomni/ledger` subpath; completion, durable-ledger, and Voice consumers are not wired

If a symbol is not re-exported from `src/index.ts`, treat it as private to its domain. The dormant
`./ledger` subpath is the one exception: `src/ledger/index.ts` exports `Stakes` and
`runStakesDriver` without widening the root barrel.

## Extension Points

- Add new tools or tool providers in `src/execution-runtime/tool/` following the `ToolProvider` interface; tools should call kernel entry points instead of making routing decisions.
- Add new messaging flows through the existing `src/ingress/` / `src/dispatch/` stages and the shipped #464 `resolveRoute` pipeline.
- Add Resident/Worker orchestration here when implementing product model contracts: authority checks, self-loop creation, worker delegation, external waits, and distilled writeback are kernel responsibilities.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD, event log, worker runs, artifact storage, and indexed record stores. Keep access semantics here, not in session.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core or generic agent-loop primitives.
- It is not the owner of provider-specific connector definitions, discovery, or installation UX. The current server connector surface under `apps/server/src/connector/` hosts provider-neutral process-driver and persisted-installation plumbing; first-party definitions and the unused discovery/registry modules were deleted, and the full installation lifecycle remains planned.

## Domain Docs

- `src/resident/AGENTS.md` does not exist yet; it is an intentionally small module.
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
