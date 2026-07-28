# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

Protocol defines shapes, not behavior. It may describe communication, actor, dispatch, work, IPC, and storage contracts, but it must not decide routing, authority, lifecycle precedence, or execution policy. Runtime meaning belongs in `@openomni/openomni` or lower primitive packages as appropriate.

## STRUCTURE

```
src/
├── index.ts              # Package barrel (re-exports all domains; event/ descriptors are re-exported here directly — its own barrel was inlined in #476)
├── actor/                # Actor.Identity / Endpoint, TrustTier, Blacklist entry schemas
├── adapter/              # Adapter.Surface / Capabilities / TriggerRule / Inbound-OutboundMessage
├── agent/                # AgentProfile.Definition (permissions field removed in #475), AgentProfile.AgentBudget
├── app-connector/        # Declarative installed-app connector ABI
├── artifact/             # Artifact.Meta, Artifact.Part
├── bus/                  # BusEvent.define() factory + BusEvent.Sink (injected event-sink interface, #477)
├── communication/        # PendingAsk / PendingInteraction schemas (transitional names for the Wait primitive, #215)
├── cron/                 # Cron job schemas
├── dispatch/             # Dispatch.Command / Actions / ActorContext / target schemas
├── error/                # NamedError factory + built-in error classes (incl. WorkerDeliveryError, #478)
├── event/                # Typed event descriptors: agent-execution, ingress, llm, mcp, operational, policy, tool
├── execution/            # Execution.Request / Result contracts + Execution.Driver command face (#478)
├── extension/            # Extension manifest schemas
├── ingress/              # InboundEvent discriminated union (DirectEvent | InternalEvent), AgentDef, IngressResult, ResolvedInboundEvent
├── ipc/                  # IPC request/response schemas and worker transport contracts
├── mcp/                  # MCP server config schemas
├── message/              # Message.Part (8 variants), Message.Info, Message.WithParts
├── model/                # Model.Ref shared model identity
├── policy/               # Point registry (19 registered policy points) + point contracts, PolicyPlan, Permission, PolicyDecision, effects
├── run/                  # Run.Snapshot / Outcome / RetryPolicy / Budget
├── sink/                 # Sink — streaming callback contract (TS interface, not Zod)
├── skill/                # Skill definition schemas
├── storage/              # Storage.WorkItemSubAdapter interface
├── token/                # Token.Usage / AgentUsage / ProviderUsage / ExecutionUsage
├── tool/                 # Tool.Spec / Call / Result / State (discriminated union)
├── tool-selection/       # ToolSelection schema for choosing tool categories and overrides
├── trace/                # TraceContext schema shared by observability helpers
├── work-item/            # Completion, executor, evidence, and read-back schema contracts
├── ledger/               # Versioned Ledger refs, events, append/CAS, evidence, verifier, workspace/effect shapes
├── wait/                 # Versioned Wait owner/responder/correlation and lifecycle event shapes
├── worker-bootstrap/     # Worker bootstrap payload contracts
└── worker-run/           # WorkerRun.Info / Status + WorkerRun.Events.*
```

Namespace additions are gated: `script/lint-tools.ts` (#467) enforces a grandfathered baseline with a no-new-violations ratchet against the core-model Tier-1/2 vocabulary, and the schema-snapshot lint flags field removals/renames (regenerate via `--update` — that diff is the review sign-off surface).
## P2-04 PRODUCTION CONTRACT

- `Ledger` and `Wait` are the production-consumed durable contracts. They expose immutable owner-keyed events, complete append batches, CAS/idempotency receipts, native Work/Attempt/Wait/effect/completion facts, replay references, and pinned correlation identities.
- These remain shape-only namespaces: protocol never appends, queries, projects, selects transitions, resolves correlations, authorizes effects, or routes work. Session owns structural persistence and OpenOmni owns product meaning.
- Legacy `WorkerRun`, `PendingAsk`, `PendingInteraction`, and optional `Storage.WorkItemSubAdapter` shapes remain only as deprecated protocol compatibility contracts. They are not production durable authority and must not gain new consumers.
- P2-04 consumers switched atomically to the native contracts and removed legacy process-local/optional-adapter authority paths. P2-05–P2-07 export/replay/C1 work remains unshipped; schema availability alone does not qualify those later milestones.

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `ProviderError` (in `@openomni/llm`) uses this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Run.Outcome` on `type`, `ExecutionEvent` on `type`, `Policy.PolicyDecision` on `verdict`. `InboundEvent` is a discriminated union on `mode`: `DirectEvent` (`mode: "direct"`) for external inbound and `InternalEvent` (`mode: "internal"`) for system-origin events (e.g., cron). The external `ingest()` path rejects `mode: "internal"` for security.
- **Sink interface**: Plain TS interface (NOT Zod) — the callback contract for streaming results. Uses `Tool.Call`, `Tool.Result`, `Run.Snapshot`.
- **BaseEvent correlation**: All events extend `BaseEvent` with `traceId`, `runId?`, `taskId?`, `sessionId?`, `time`.
- **Policy points**: `policy/point-registry.ts` registers 19 policy points (`session.inbound.pre`, `dispatch.action.pre`, `run.lifecycle.pre/post`, `run.turn.pre/post`, `run.completion.pre`, `run.error.error`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog.pre`, `tool.native.pre/post`, `tool.mcp.pre/post`, `delegation.worker.pre/post`, `session.writeback.pre`), each with an allowed-effects whitelist, default fail policy, required context, and input schema (`point-contract.ts`). `preBoundary` is `fail-closed` with `sideEffectBoundary: true`; `postBoundary` is `fail-open` with `sideEffectBoundary: false` because the guarded act has already occurred. Post-boundary continuation is an availability fail-safe only: the policy failure must remain observable and cannot authorize another effect or count as durable evidence. `prompt.context.pre` is the grounded current advisory exception (`fail-open`, boundary `true`), not a precedent for authoritative pre-act paths. `Policy.PolicyPlan` (`plan.ts`) is the stamped per-task plan shape (#479). `Policy.PolicyDecision` verdict is one of `allow | deny | pending`. A legacy `Policy.Timing` alias survives for pre-v2 timing names; do not build new code on it.
- **Legacy WorkerRun lifecycle**: `WorkerRun.Events.*` is a deprecated protocol-only event surface. Production lifecycle authority is native Ledger Work/Attempt transitions; do not add new WorkerRun consumers.
- **Legacy storage sub-adapter**: `Storage.WorkItemSubAdapter` remains a deprecated shape-only contract with no production authoritative consumer. Optionality never authorizes silent durability fallback.
- **WorkItem namespace**: `work-item/index.ts` is the public facade for `ExecutorKind`, `CompletionReport`, `Evidence`, and the read-back request/check/envelope schemas consumed by execution and connector paths.
- **Execution/IPC contracts**: `execution/`, `ipc/`, and `worker-bootstrap/` describe worker requests, responses, and bootstrap payloads only. Runtime worker lifecycle lives in `@openomni/coordinator`.
- **AppConnector namespace**: `app-connector/index.ts` defines installed-app connector schema contracts. Runtime install, consent, and process execution live above protocol.
- **Trace contract**: `trace/index.ts` defines the shared shape; helper creation lives in `@openomni/session`.

## CONTRACT BOUNDARY

Allowed here:

- Zod schemas and inferred TypeScript types.
- Bus event descriptors via `BusEvent.define()`.
- Storage adapter interfaces.
- Wire/request/response contracts for IPC, execution, ingress, dispatch, and tools.
- Pure schema-local validation helpers that do not consult storage or runtime facts.

Not allowed here:

- PendingInteraction/PendingAsk match precedence.
- Actor trust, channel grant, worker grant, or blacklist evaluation.
- Session or target resolution.
- Dispatch/ingress handler routing.
- Provider behavior, process supervision, storage implementation, or agent-loop execution.

If a helper needs data from stores, runtime context, channel facts, or policy decisions, it does not belong in protocol.

## FUTURE PRODUCT MODEL CONTRACTS

The product model is documented in `docs/core-model.md`. Future schemas should live here when they become implementation work:

- Resident/Worker profile and lifecycle contracts;
- inbound authority / actor role contracts;
- self-loop session metadata;
- distilled writeback records;
- memory candidate records for Anamnesis ingestion.

Keep these as protocol contracts only. Runtime policy and storage implementations belong in upper packages.
P2 contract rule: `Ledger` and `Wait` provide the canonical versioned production shapes. Do not introduce sibling vocabularies, legacy lifecycle consumers, or protocol runtime helpers; production wiring and fail-closed behavior remain responsibilities of Session, OpenOmni, and the host composition root.

Future Jester-evaluation shapes are contracts only: they add no behavior, dispatch authority, scheduling, or durable lifecycle to this package. They must extend the canonical namespaces rather than introduce a new Tier-2 noun; runtime meaning remains with the kernel and its host. See the [kernel contract](../../docs/kernel-contract.md) for normative lifecycle semantics.

## ANTI-PATTERNS

- Do NOT add runtime logic here — this package is schemas/types only.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.
- Do NOT add authority or communication-kernel shortcuts here. Add the schema here, then implement semantics in `packages/openomni`.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and extend `BaseEvent`.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new run type? Add to the `Run` namespace in `run/index.ts`.
- Adding a new policy point? Register it in `policy/point-registry.ts` with a full contract (allowed effects, fail policy, required context, input schema) and coordinate with the engine in `packages/policy` — point additions are protocol vocabulary and ride the #467 gate.
- Adding a new worker-run event? Extend `WorkerRun.Events` in `worker-run/index.ts` with a `BusEvent.define()` call.
- Adding a new storage sub-adapter interface? Add it to `storage/index.ts` as a named interface under the `Storage` namespace.
- Adding a work-item completion, executor, evidence, or read-back field? Update the retained contract in `work-item/schemas.ts` and its focused schema tests.
- Adding a new worker request or IPC field? Update `execution/`, `ipc/`, or `worker-bootstrap/` here first, then adapt coordinator/openomni/server callers.
- Adding trace metadata? Update `trace/index.ts`; helper functions stay in `@openomni/session`.
- This package builds to `dist/` — run `bun run build` after changes.
