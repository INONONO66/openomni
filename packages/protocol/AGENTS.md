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
├── event/                # Task.*, Agent.* events + event/agent-execution.ts (AgentExecution.*)
├── notification/         # NotificationRequest / Result / Severity / DeliveryMode
├── adapter/              # Adapter.Surface / Capabilities / TriggerRule / Inbound-OutboundMessage
├── plan/                 # Plan, PlanStep (DAG), PlanResult with acyclic validation
├── ingress/              # InboundEvent (plan | direct), AgentDef, IngressResult
├── messenger/            # MessageEnvelope, PersistencePolicy, AllowPattern, AuditEntry
├── guardrail/            # ToolPermission, InputRule, DelegationPolicy
├── event-log/            # ExecutionEvent discriminated union (LLM / tool / step / session)
├── agent/                # AgentProfile.Definition, AgentProfile.AgentBudget
├── artifact/             # Artifact.Meta, Artifact.Part
├── gate/                 # Gate.Check / Enricher / Verdict / Issue (plan validation)
├── hook/                 # Hook.Timing (9), Hook.Verdict (6), Middleware.Definition + FailPolicy
└── subagent/             # ChildSession / WorkerRun / ConsultationRequest / BackgroundTask + Subagent.Events.*
```

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `AuthError`, `ProviderError`, etc. use this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Run.Outcome` on `type`, `InboundEvent` on `mode`, `ExecutionEvent` on `type`, `Hook.Verdict` on `action`.
- **Sink interface**: Plain TS interface (NOT Zod) — the callback contract for streaming results. Uses `Tool.Call`, `Tool.Result`, `Run.Snapshot`.
- **BaseEvent correlation**: All events extend `BaseEvent` with `traceId`, `runId?`, `taskId?`, `sessionId?`, `time`.
- **Hook timings**: 9 middleware timing points — `pre_run`, `pre_turn`, `on_system_prompt`, `pre_tool_use`, `post_tool_use`, `post_turn`, `post_compaction`, `post_run`, `on_error`. `Hook.Verdict` returns one of `continue | skip | abort | retry | transform | inject`.
- **Subagent lifecycle**: `Subagent.Events.*` covers worker sessions (`WorkerSessionSpawned/Resumed/Cancelled`), worker runs (`WorkerRunStarted/Completed/Failed`), consultations (`WorkerConsultationRequested/Completed`), and background tasks (`BackgroundTaskLaunched/Completed/Failed/Cancelled`).
- **Plan DAG validation**: `PlanSchema.superRefine()` enforces unique `stepId` values and acyclic `dependsOn` references.

## ANTI-PATTERNS

- Do NOT add runtime logic here — this package is schemas/types only.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and extend `BaseEvent`.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new run type? Add to the `Run` namespace in `run/index.ts`.
- Adding a new middleware timing? Update `Hook.Timing` in `hook/index.ts` and coordinate with `packages/agent/src/core/middleware/engine.ts`.
- Adding a new subagent event? Extend `Subagent.Events` in `subagent/index.ts` with a `BusEvent.define()` call.
- This package builds to `dist/` — run `bun run build` after changes.
