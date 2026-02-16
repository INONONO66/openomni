# packages/agent

Core orchestration package. Multi-agent task system with Dynamic Supervisor architecture, event-driven ingress pipeline, tools, triggers, and conversation handling. Largest package (~40 source files). Depends on protocol, session, and llm.

## STRUCTURE

**10 top-level domains** with sub-domains for finer-grained SRP:

```
src/
├── index.ts                    # Public API barrel
├── agent/                      # Agent identity, registry, messaging
│   ├── definitions.ts          # AgentDefinitionLoader, AgentProfile, AgentCapabilities, AgentRuntime (merged from definition/)
│   ├── discovery.ts            # AgentDiscovery, parseFrontmatter (merged from discovery/)
│   ├── registry/               # Agent registry and lookup
│   │   ├── builtin.ts          # BuiltinAgentRegistry — register/lookup agents (lazy initialization)
│   │   └── index.ts            # Re-exports
│   ├── communication.ts        # AgentMessenger — A2A message delivery with asker_only persistence
│   └── index.ts                # Re-exports (domain barrel)
├── config/
│   └── index.ts                # AutonomousLoopConfig + ConfigManager (defaults, merge, validate)
├── conversation/               # User-facing orchestration
│   ├── conversation-supervisor.ts  # ConversationSupervisor — requirement gathering, plan authoring, approval gate
│   └── index.ts                # Re-exports (domain barrel)
├── dispatch/                   # Event pipeline (envelope → router → dispatcher)
│   ├── envelope.ts             # EventEnvelope — normalize + validate incoming events
│   ├── router.ts               # Router — match events to rules, produce RoutingDecision
│   ├── dispatcher.ts           # Dispatcher — execute routed events
│   └── index.ts                # Re-exports (domain barrel)
├── execution/                  # DAG execution engine
│   ├── graph/                  # DAG graph building and dependency management
│   │   ├── execution-graph.ts  # DAG construction and traversal (includes FileLock)
│   │   └── index.ts            # Re-exports
│   ├── execution-review.ts     # ExecutionReview, review gate, handoff, agent rotation (merged from review/)
│   ├── execution-supervisor.ts # ExecutionSupervisor — DAG execution engine (1073 lines)
│   ├── execution-types.ts      # Execution domain types — SupervisorDecision, ExecutionPlan, StepOutcome
│   └── index.ts                # Re-exports (domain barrel)
├── ingress/                    # Dynamic Supervisor — event ingestion pipeline
│   ├── engine.ts               # IngressEngine — 7-step pipeline (validate→convert→dedup→resolve→plan→execute→deliver)
│   ├── session-resolver.ts     # SessionResolver — resolve/create sessions from events
│   ├── event-projector.ts      # EventProjector — extract session data from events
│   ├── run-executor.ts         # DefaultRunExecutor — execute run requests
│   ├── event-kinds.ts          # EventKind constants, EventLane classification, isTaskBackable()
│   └── index.ts                # Re-exports (domain barrel)
├── task/                       # Task lifecycle management
│   ├── lifecycle/              # Task state machine and transitions
│   │   ├── state-machine.ts    # TaskStatusManager — valid status transitions
│   │   ├── recovery.ts         # CrashRecovery, CheckpointManager (merged from storage/checkpoint.ts)
│   │   └── index.ts            # Re-exports
│   ├── storage/                # Task persistence
│   │   ├── storage.ts          # TaskStorage + InMemoryTaskStore
│   │   └── index.ts            # Re-exports
│   ├── types.ts                # Task namespace — Task, TaskRun, TriggerSignal Zod schemas
│   ├── manager.ts              # TaskManager, PolicyError (merged from errors.ts)
│   ├── trigger-engine.ts       # Trigger orchestration — schedule/webhook/fs event handling
│   └── index.ts                # Re-exports (domain barrel)
├── tools/                      # Dynamic Supervisor tools (subagent, dispatch, schedule)
│   ├── subagent.ts             # SubagentTool — spawn child agents (includes SubagentInput schema)
│   ├── dispatch.ts             # DispatchTool — send A2A messages (includes DispatchInput schema)
│   ├── schedule.ts             # ScheduleTool — create/update/delete schedules (includes ScheduleInput schema)
│   └── index.ts                # Re-exports (domain barrel)
├── trigger/                    # External event sources
│   ├── scheduler.ts            # Scheduler — timeBucket idempotency, recurring schedules, drift detection
│   ├── watcher.ts              # FilesystemWatcher
│   ├── webhook.ts              # WebhookWatcher (abstract) + SimpleWebhookWatcher
│   └── index.ts                # Re-exports (domain barrel)
└── worker/                     # Execution runtime primitives
    ├── run/                    # RunWorker execution
    │   ├── worker.ts           # RunWorker — shared execution primitive (LLM/tool loop, retry, budget, session lifecycle)
    │   ├── sink.ts             # Session sink setup for RunWorker
    │   └── index.ts            # Re-exports
    ├── policy.ts               # ConcurrencyGate, PermissionGate, RunSupervisor (merged from policy/)
    ├── telemetry.ts            # AuditLog, Observability, SummaryDelivery (merged from telemetry/)
    ├── agent-resolution.ts     # Agent resolution — AgentDefinition → LLM/tools/prompt
    ├── dlq.ts                  # DeadLetterQueue — failed event storage
    └── index.ts                # Re-exports (domain barrel)
```

**Key architectural changes**:

- **dispatch/** replaces loop/'s event pipeline (envelope → router → dispatcher)
- **worker/** replaces loop/'s runtime primitives (RunWorker + policies + telemetry)
- **execution/** replaces loop/'s DAG execution (ExecutionSupervisor + graph + review)
- **conversation/** now contains conversation-supervisor.ts (merged from loop/)
- **Sub-domains** provide finer-grained SRP within agent/, worker/, task/, execution/
- **loop/ directory removed** — all functionality redistributed to domain-specific modules

## PIPELINE FLOW

### IngressEngine 7-Step Pipeline

```
1. Validate (schema validation)
2. Convert (EventSourceAdapter → EventEnvelope)
3. Dedup (idempotency check)
4. Resolve (SessionResolver → session)
5. Plan (RunPlanner → RunRequest)
6. Execute (RunExecutor → RunOutcome)
7. Deliver (NotificationAdapter → NotificationResult)
```

### Event Processing Pipeline (dispatch/ + worker/)

```
Trigger (cron/webhook/fs/manual)
  → Envelope (normalize + validate + dedupe)
    → Router (match rules → RoutingDecision)
      → Dispatcher (execute)
        → ConcurrencyGate (lane-based control)
          → PermissionGate (ask/notify/deny policy)
            → RunWorker (LLM/tool loop)
              → RunSupervisor (budget enforcement)
                → Summary + AuditLog
                  → DLQ (on failure)
```

**Key components**:

- **dispatch/envelope.ts**: Normalize + validate incoming events
- **dispatch/router.ts**: Match events to rules, produce RoutingDecision
- **dispatch/dispatcher.ts**: Execute routed events
- **worker/policy.ts**: ConcurrencyGate, PermissionGate, RunSupervisor
- **worker/run/**: RunWorker execution primitive
- **worker/telemetry.ts**: AuditLog, Summary, Observability

## KEY PATTERNS

### Supervisor/Worker Split

Separates orchestration decisions from execution:

- **ConversationSupervisor** (conversation/): User-facing orchestration. Handles requirement gathering, clarification, plan authoring, and approval gate. Session mode: `reuse` (if exists) or `persistent`.
- **ExecutionSupervisor** (execution/): Execution orchestration. Handles task decomposition, assignment, accept/reject, re-dispatch loop. Session mode: `persistent`. Internal-only (no direct external entry).
- **RunWorker** (worker/run/): Shared execution primitive. Handles LLM/tool loop, retry, budget, session lifecycle, state transitions. Used by both supervisors and tools (SubagentWorker, DispatchCoordinator).
- **Execution flow**: External events → ConversationSupervisor → (after approval) → ExecutionSupervisor → RunWorker

### ConversationSupervisor Lifecycle

7-step framework for user-facing orchestration:

1. **Session Resolution**: Reuse existing session or create new (`persistent` mode)
2. **Agent Resolution**: Load AgentDefinition (prompt/model/tools) via `config.agentId` or use default
3. **LLM Turn**: Call RunWorker with injected AgentDefinition
4. **Intent Classification**: LLM calls `classify_intent` tool → `immediate` or `plan_needed`
5. **Plan Generation** (if plan_needed): LLM calls `generate_plan` tool → includes `suggestedAgent` per work item (from `BuiltinAgentRegistry.list()`)
6. **Approval Gate**: Returns `plan_pending` → external system presents to user (D11: no auto-approval)
7. **Fork + Delegation** (after approval): External system creates fork (summarized history only, D10) → calls ExecutionSupervisor

**Framework Layer**: Lifecycle is fixed, behavior is injectable via AgentDefinition. Define custom supervisor via `BuiltinAgentRegistry.define({ name: "conversation-supervisor", systemPrompt: "...", tools: [...], model: {...} })`.

### Event Processing Pipeline

**dispatch/** domain handles event normalization and routing:

- **envelope.ts**: Normalize + validate incoming events (EventEnvelope)
- **router.ts**: Match events to rules, produce RoutingDecision
- **dispatcher.ts**: Execute routed events

**worker/** domain handles execution and policies:

- **worker/run/**: RunWorker execution primitive (LLM/tool loop, retry, budget, session lifecycle)
- **worker/policy.ts**: ConcurrencyGate (lane-based control), PermissionGate (ask/notify/deny), RunSupervisor (budget enforcement)
- **worker/telemetry.ts**: AuditLog (event audit trail), Summary (post-run summary), Observability (metrics)

### Domain Barrel Pattern

**Cross-domain imports MUST go through domain-level barrel**:

```typescript
// ✅ CORRECT: Import from domain barrel
import { RunWorker } from "../worker";
import { ExecutionSupervisor } from "../execution";

// ❌ WRONG: Never import from sub-domain directly
import { RunWorker } from "../worker/run";
import { ExecutionSupervisor } from "../execution/graph";
```

**Sub-domain imports are internal only** — external consumers never import `from "../worker/run"` or `from "../execution/graph"`. Barrel pattern ensures stable public API and single source of truth.

### Other Key Patterns

- **SubagentWorker**: Single-task worker unit. Session mode: `ephemeral` (one-shot delegated work).
- **DispatchCoordinator**: Multi-task coordinator for DAG execution. Child worker session mode: `persistent + reuse` (for review/retry/handoff continuity).
- **Dynamic Supervisor**: IngressEngine + 3 tools (SubagentTool, DispatchTool, ScheduleTool). Replaces graph-based routing.
- **surfaceKey**: Unique agent identifier (`{namespace}:{name}:{version}`). Used for registry lookup and A2A addressing.
- **A2A Persistence**: `asker_only` policy — only asking agent stores messages. Audit log via `AgentMessenger.getAuditLog()`.
- **Event Lanes**: Control lane (task-backable) vs Telemetry lane (ephemeral). Classified via `classifyLane()`.
- **Scheduler Idempotency**: Uses `timeBucket` (5-min windows) instead of exact timestamp for dedupeKey.
- **Recurring Schedules**: `recurring: true` flag wired to TriggerCron/TriggerInterval in ScheduleTool.
- **Late-Start Execution**: Schedules with `start_time_in_past` execute immediately with `lateStart: true` flag.
- **Drift Detection**: Scheduler warns if execution is >5min late from planned start time.
- **Lane Guard**: DefaultRunPlanner blocks telemetry events from creating runs.
- **Modular Execution**: ExecutionSupervisor split into focused modules — types (SupervisorDecision, ExecutionPlan), graph (DAG building), review (handoff/rotation). Main supervisor orchestrates these components.
- **TaskManager**: `TaskManager.create()` → `TaskManager.trigger(taskId, signal)` → returns `{ runId }` or `{ error }`.
- **RunWorker.run()**: Main execution entry. Takes `{ taskId, runId, maxRetries, sessionMode, sessionId, maxSubagentDepth, currentDepth }` + `{ llm, input, toolExecutor }`. Returns `{ success, summary, error }`.
- **ConfigManager.create()**: Deep-merge overrides into defaults. Validated with `ConfigManager.validate()`.
- **State machine**: TaskStatusManager enforces valid transitions (e.g., `pending→active→completed`).
- **Lazy Initialization**: BuiltinAgentRegistry uses lazy initialization — builtins are registered on first access to `get()`, `list()`, `has()`, or `size()`. Explicit `initializeBuiltins()` call is supported for testing.

## ANTI-PATTERNS

- **loop/ directory removed** — All functionality redistributed to domain-specific modules (dispatch/, worker/, execution/, conversation/). Do NOT import from `loop/` — it no longer exists.
- **Sub-domain imports forbidden** — Never import directly from sub-domains like `worker/run`, `execution/graph`, `agent/registry`, `task/lifecycle`, `task/storage`. Always import through domain barrel (e.g., `from "../worker"`, `from "../execution"`). Merged files (definitions.ts, discovery.ts, policy.ts, telemetry.ts, execution-review.ts) are internal to their domains.
- **Orchestrator.run() REMOVED** — `orchestration.ts` has been deleted. Use `RunWorker.run()` directly for all execution. The compatibility facade no longer exists.
- QueueMetrics name conflict between `trigger/` and `worker/telemetry.ts` — re-exported with aliases (`TriggerQueueMetrics`, `WorkerQueueMetrics`) in index.ts.
- `require()` was used in `summary.ts` at one point — fixed. Keep ESM imports only.
- Do NOT reference `graph.ts` or `routing.ts` — these were removed in Phase 1 migration to Dynamic Supervisor.
- **Deleted files** — Do NOT import from: `config.ts` (use `config/index.ts`), `conversation/handler.ts` (use `conversation/index.ts`), `tools/schemas.ts` (schemas co-located with tools), `ingress/interfaces.ts` (interfaces co-located with implementations).
- **Renamed exports** — `TaskStateMachine` is now `TaskStatusManager` (state-machine.ts). Old name exists as deprecated alias in task/index.ts.
