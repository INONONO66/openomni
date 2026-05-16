# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

## STRUCTURE

```
src/
├── index.ts              # Package barrel (re-exports all domains)
├── error/                # NamedError factory + built-in error classes
├── tool/                 # Tool.Spec / Call / Result / State (discriminated union)
├── message/              # Message.Part (8 variants), Message.Info, Message.WithParts
├── run/                  # Run.Snapshot / Outcome / RetryPolicy / Budget
├── sink/                 # Sink — streaming callback contract (TS interface, not Zod)
├── bus/                  # BusEvent.define() factory for typed event descriptors
├── event/                # Event contracts + event/agent-execution.ts (AgentExecution.*)
├── notification/         # NotificationRequest / Result / Severity / DeliveryMode
├── adapter/              # Adapter.Surface / Capabilities / TriggerRule / Inbound-OutboundMessage
├── ingress/              # InboundEvent (direct), AgentDef, IngressResult
├── messenger/            # MessageEnvelope, PersistencePolicy, AllowPattern, AuditEntry
├── policy/               # Policy.Permission, Policy.InputRule, Policy.DelegationPolicy, Policy.Timing (14), Policy.PolicyDecision, Policy.Definition + FailPolicy, Policy.PolicyEffect, RuntimeResource.Descriptor
├── event-log/            # ExecutionEvent discriminated union (LLM / tool / step / session)
├── execution/            # ExecutionRequest / ExecutionResult / WorkerCommand contracts
├── agent/                # AgentProfile.Definition, AgentProfile.AgentBudget
├── artifact/             # Artifact.Meta, Artifact.Part
├── ipc/                  # IPC request/response schemas and worker transport contracts
├── storage/              # Storage.WorkItemSubAdapter interface
├── work-item/            # WorkItem.Info, Blocker, Evidence, VerificationGate, Status, deriveStatus(), generateHash(), WorkItem.Events.*
├── tool-selection/       # ToolSelection schema for choosing tool categories and overrides
├── trace/                # TraceContext schema shared by observability helpers
├── worker-bootstrap/     # Worker bootstrap payload contracts
└── subagent/             # ChildSession / WorkerRun / ConsultationRequest / BackgroundTask + Subagent.Events.*
```

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `AuthError`, `ProviderError`, etc. use this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Run.Outcome` on `type`, `ExecutionEvent` on `type`, `Policy.PolicyDecision` on `verdict`. `InboundEvent` currently uses a single `mode: "direct"` variant.
- **Sink interface**: Plain TS interface (NOT Zod) — the callback contract for streaming results. Uses `Tool.Call`, `Tool.Result`, `Run.Snapshot`.
- **BaseEvent correlation**: All events extend `BaseEvent` with `traceId`, `runId?`, `taskId?`, `sessionId?`, `time`.
- **Policy timings**: 14 policy timing points — `inbound.receive`, `run.start`, `turn.start`, `context.prepare`, `resources.prepare`, `model.request`, `model.response`, `invoke.prepare`, `invoke.result`, `turn.finish`, `completion.prepare`, `writeback.commit`, `run.finish`, `error`. `Policy.PolicyDecision` verdict is one of `allow | deny | pending`; legacy permission evaluators still use `EvaluationResult.action` (`continue | abort`).
- **Subagent lifecycle**: `Subagent.Events.*` covers worker sessions (`WorkerSessionSpawned/Resumed/Cancelled`), worker runs (`WorkerRunStarted/Completed/Failed`), consultations (`WorkerConsultationRequested/Completed`), and background tasks (`BackgroundTaskLaunched/Completed/Failed/Cancelled`).
- **Storage sub-adapters**: `Storage.WorkItemSubAdapter` in `storage/index.ts` — pure interface contract with no runtime logic. Implementation lives in `@openomni/session`.
- **WorkItem namespace**: `work-item/index.ts` defines `WorkItem.Info` (universal work state schema with derived status, blockers, evidence, verification gates), `WorkItem.Events.*` (Created, Updated, StatusChanged, Completed, Failed, Removed via `BusEvent.define()`), `deriveStatus()` (pure status derivation from timestamps/blockers), and `generateHash()` (base36 12-char collision-safe IDs).
- **Execution/IPC contracts**: `execution/`, `ipc/`, and `worker-bootstrap/` describe worker requests, responses, and bootstrap payloads only. Runtime worker lifecycle lives in `@openomni/coordinator`.
- **Trace contract**: `trace/index.ts` defines the shared shape; helper creation lives in `@openomni/session`.

## FUTURE PERSONA CONTRACTS

The persona workforce direction is documented in `docs/persona-workforce.md`. Future schemas should live here when they become implementation work:

- persona profile and lifecycle contracts;
- inbound authority / actor role contracts;
- self-loop session metadata;
- distilled writeback records;
- memory candidate records for Anamnesis ingestion.

Keep these as protocol contracts only. Runtime policy and storage implementations belong in upper packages.

## ANTI-PATTERNS

- Do NOT add runtime logic here — this package is schemas/types only.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and extend `BaseEvent`.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new run type? Add to the `Run` namespace in `run/index.ts`.
- Adding a new policy timing? Update `Policy.Timing` in `policy/index.ts` and coordinate with `packages/agent/src/core/policy/engine.ts`.
- Adding a new subagent event? Extend `Subagent.Events` in `subagent/index.ts` with a `BusEvent.define()` call.
- Adding a new storage sub-adapter interface? Add it to `storage/index.ts` as a named interface under the `Storage` namespace.
- Adding a work-item field? Update `WorkItem.Info` in `work-item/index.ts`. If it affects status derivation, update `deriveStatus()`.
- Adding a work-item event? Extend `WorkItem.Events` in `work-item/index.ts` with a `BusEvent.define()` call.
- Adding a new worker request or IPC field? Update `execution/`, `ipc/`, or `worker-bootstrap/` here first, then adapt coordinator/openomni/server callers.
- Adding trace metadata? Update `trace/index.ts`; helper functions stay in `@openomni/session`.
- This package builds to `dist/` — run `bun run build` after changes.
