# packages/openomni

Product kernel for OpenOmni. Builds on `@openomni/agent`, `@openomni/policy`, `@openomni/session`, and `@openomni/protocol` to own messaging/routing, access control, Resident/Worker orchestration, ledger/evidence gates, dispatch, and worker execution tooling. Lower packages provide primitives; this package decides product meaning.

## Module Map

| Domain | Purpose | Key exports |
| --- | --- | --- |
| `src/agents/` | Built-in agent definitions and model-specific prompt variants | `ResidentAgent` |
| `src/resident/` | Resident runtime lifecycle (in-process execution, direct mode) | `ResidentRuntime` |
| `src/ingress/` | Current inbound stage: authority middleware, session resolution, projection, resident/direct execution | `IngressEngine`, `IngressEventProjector`, `IngressHandlers`, `IngressSessionResolver`, `SessionBridge`, `CronAdapter`, `resolveTarget`, `targetKey` |
| `src/dispatch/` | Current egress/cross-boundary stage: command authorization, handler routing, PendingInteraction routing, gate-side policy stamping (#479) | `DispatchRuntime`, `DispatchRegistry`, `createDefaultDispatchRuntime` (+ `BuiltInDispatchOptions.policyResolver`), `DEFAULT_DISPATCH_MODEL` |
| `src/policy/` | Gate-side policy resolution: actor/target labels → stamped `policyPlan` on spawn requests (production-wired by #479) | `PolicyResolver` |
| `src/evidence/` | Read-back executors: URL re-fetch, API re-query, citation matching for completion gating | `ReadBackExecutor` |
| `src/execution-runtime/` | Tool system, workspace, worker middleware, and scheduled job runtime | `buildWorkerMiddleware`, `WorkspaceLock`, `AgentToolProvider`, `SystemToolProvider`, `ToolProxyProvider`, `Tool`, `buildToolCatalog`, `createToolExecutor`, `defineTool`, `InjectionQueue`, `CronJobRegistry`, `CronJobRunner` |

## Architecture

- `src/agents/` contains built-in agent definitions. `src/agents/resident/prompt/` holds the Resident system prompt with model-specific variants (Claude, GPT) and a shared builder. `ResidentAgent.getPrompt({ model })` selects the right variant by provider.
- `src/resident/` provides `ResidentRuntime` for in-process Resident execution without coordinator dispatch.
- Target structure is set by the v2 roadmap, not by new facade folders: inbound routing converges on one kernel `resolveRoute` pipeline (#464), and the P3 package plan (#456) keeps `ingress/`, `dispatch/`, `policy/`, `evidence/`, and the cron/injection parts of `execution-runtime/` in the kernel while `resident/` and `agents/` move to `apps/server`. Until those land, the standing rule holds: OpenOmni owns principal resolution handoff, access checks, correlation, session/target resolution, projection, writeback, and response routing.
- `src/ingress/` is the current inbound stage. It resolves a session through `SurfaceKey`, projects the event into stored messages, then dispatches to the resident/direct handler. `ingestInternal()` accepts internal-origin events (e.g., from `CronAdapter`) without going through the external ingest path. `CronAdapter.fire(job)` creates internal events with `surface="cron"`.
- `src/dispatch/` is the current cross-boundary command stage. `DispatchRuntime.submit()` authorizes commands, routes PendingInteraction replies, invokes registered handlers, and emits audit events. Treat dispatch as a kernel stage, not as a standalone product layer.
- `src/execution-runtime/tool/agent/tools/dispatch.ts` is the `dispatch` tool — the runtime-to-runtime/system egress gate. Worker-to-Resident awaited requests use `resident.ask`; scheduling uses `schedule.create`; cron fire remains internal ingress. `Dispatch.submit()` enforces PolicyEngine authorization and emits Bus audit events. See `src/dispatch/` for the runtime, handlers, and policy.
- `src/execution-runtime/injection-queue.ts` (`InjectionQueue`) holds async responses keyed by `runId`. The worker middleware drains the queue at `turn.finish` and injects pending responses into the agent's next turn.
- `src/execution-runtime/cron-job-registry.ts` (`CronJobRegistry`) stores scheduled jobs through the session storage adapter and keeps a process-local fallback map when durable storage is absent. `src/execution-runtime/cron-job-runner.ts` (`CronJobRunner`) polls the registry and accepts an injected fire implementation; server boot wires that to `CronAdapter.fire(job)`.
- Do not create aspirational domain folders. The folder plan is owned by #456 (P3 disposition map) and #464 (resolveRoute); current folders stay until those issues move them.
- Resident/Worker orchestration seams, controlled inbound access, self-loop session creation, Worker delegation, durable external waits, ledger/evidence gates, and distilled writeback all belong in this package.

WHY: each domain stays small and focused so the domain docs can stay source-of-truth instead of repeating.

## Kernel Design Rules

- Messaging/access semantics live here. If a change decides target, session, run, principal, trust, grant, pending correlation, writeback, or response routing, implement it in `openomni`.
- `ingress/` and `dispatch/` are implementation stages. New cross-boundary routing must not add another server-side or tool-side special case — it lands in the kernel stages and converges on the `resolveRoute` pipeline (#464).
- Do not let `apps/server` inspect `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WorkerGrantStore`, `ChannelGrantStore`, or `BlacklistStore` for routing. Server passes normalized facts; OpenOmni decides.
- Do not let `packages/session` decide authority or match precedence. It may store and query records; OpenOmni owns lifecycle transitions that have product meaning.
- Do not let `packages/coordinator` decide actor/session authority. It executes primitive worker-process operations requested by this package.
- Do not let `packages/agent` grow OpenOmni-specific durable lifecycle. Session-backed worker/background orchestration stays here.

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
execution-runtime/  → no orchestration deps (tool system, workspace, middleware)
ingress/            → no sibling deps
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
- Add new messaging flows through the existing `src/ingress/` / `src/dispatch/` stages (the #464 resolveRoute pipeline is the convergence point).
- Add Resident/Worker orchestration here when implementing product model contracts: authority checks, self-loop creation, worker delegation, external waits, and distilled writeback are kernel responsibilities.
- Extend ingress handling in `src/ingress/` when new inbound surfaces or mode dispatch rules arrive.

## What This Package Is Not

- It is not the LLM provider layer. Use `@openomni/llm` for model access.
- It is not the session package. Use `@openomni/session` for session CRUD, event log, worker runs, artifact storage, and indexed record stores. Keep access semantics here, not in session.
- It is not the pure agent runtime. Use `@openomni/agent` when you only need the `ChatAgent` core or generic agent-loop primitives.
- It is not the owner of external app connector manifests, discovery, or installation UX. Server-owned connector definitions and provider drivers live under `apps/server/src/connector/`.

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
