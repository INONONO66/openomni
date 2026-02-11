# packages/agent

Core orchestration package. Multi-agent task system with Dynamic Supervisor architecture, event-driven ingress pipeline, tools, triggers, and conversation handling. Largest package (~40 source files). Depends on protocol, session, and llm.

## STRUCTURE

```
src/
├── index.ts           # Public API barrel
├── config.ts          # AutonomousLoopConfig + ConfigManager (defaults, merge, validate)
├── ingress/           # Dynamic Supervisor — event ingestion pipeline
│   ├── engine.ts      # IngressEngine — 7-step pipeline (validate→convert→dedup→resolve→plan→execute→deliver)
│   ├── interfaces.ts  # EventSourceAdapter, EventDecoder, NotificationAdapter, RunPlanner, RunExecutor
│   ├── session-resolver.ts  # SessionResolver — resolve/create sessions from events
│   ├── event-projector.ts   # EventProjector — extract session data from events
│   ├── run-executor.ts      # DefaultRunExecutor — execute run requests
│   ├── event-kinds.ts       # EventKind constants, EventLane classification, isTaskBackable()
│   └── index.ts       # Re-exports
├── tools/             # Dynamic Supervisor tools (subagent, dispatch, schedule)
│   ├── subagent.ts    # SubagentTool — spawn child agents
│   ├── dispatch.ts    # DispatchTool — send A2A messages
│   ├── schedule.ts    # ScheduleTool — create/update/delete schedules
│   ├── schemas.ts     # Shared Zod schemas for tool inputs
│   └── index.ts       # Re-exports
├── agent/             # Agent identity, registry, messaging, supervision
│   ├── profile.ts     # AgentProfile, AgentIdentity, AgentRuntime
│   ├── registry.ts    # AgentRegistry — register/lookup agents by surfaceKey
│   ├── communication.ts  # AgentMessenger — A2A message delivery with asker_only persistence
│   ├── supervision.ts # Agent supervision patterns
│   └── index.ts       # Re-exports
├── task/              # Task lifecycle management
│   ├── types.ts       # Task, TaskRun, TriggerSignal Zod schemas
│   ├── manager.ts     # TaskManager — create, trigger, getRun, state transitions
│   ├── storage.ts     # TaskStorage + InMemoryTaskStore
│   ├── state-machine.ts  # TaskStateMachine — valid status transitions
│   ├── checkpoint.ts  # CheckpointManager — save/restore run state
│   └── recovery.ts    # CrashRecovery — detect and recover failed runs
├── loop/              # Supervisor/Worker execution architecture
│   ├── conversation-supervisor.ts  # ConversationSupervisor — user-facing orchestration (requirement gathering, plan authoring, approval gate)
│   ├── execution-supervisor.ts     # ExecutionSupervisor — DAG execution engine (dependency graph, review gate, handoff)
│   ├── run-worker.ts               # RunWorker — shared execution primitive (LLM/tool loop, retry, budget, session lifecycle)
│   ├── file-lock.ts   # FileLock — in-process file locking for dispatch coordination
│   ├── agent-resolution.ts  # Agent resolution — AgentDefinition → LLM/tools/prompt
│   ├── envelope.ts    # EventEnvelope — normalize + validate incoming events
│   ├── router.ts      # Router — match events to rules, produce RoutingDecision
│   ├── dispatcher.ts  # Dispatcher — execute routed events
│   ├── concurrency.ts # ConcurrencyGate — lane-based concurrency control
│   ├── permission.ts  # PermissionGate — ask/notify/deny policy enforcement
│   ├── run-supervisor.ts  # RunSupervisor — budget enforcement (time, turns, tool calls)
│   ├── dlq.ts         # DeadLetterQueue — failed event storage
│   ├── summary.ts     # SummaryDelivery — post-run summary generation
│   ├── audit.ts       # AuditLog — event audit trail
│   ├── observability.ts   # Observability — metrics collection
│   └── supervisor.ts  # Higher-level supervisor (deprecated — use run-supervisor)
├── trigger/           # External event sources
│   ├── scheduler.ts   # Scheduler — timeBucket idempotency, recurring schedules, drift detection
│   ├── queue.ts       # EventQueue — priority queue with drop policies
│   ├── watcher.ts     # FilesystemWatcher
│   └── webhook.ts     # WebhookWatcher (abstract) + SimpleWebhookWatcher
└── conversation/
    └── handler.ts     # ConversationRequestHandler — inline-vs-task heuristics
```

## PIPELINE FLOW

```
IngressEngine 7-Step Pipeline:
  1. Validate (schema validation)
  2. Convert (EventSourceAdapter → EventEnvelope)
  3. Dedup (idempotency check)
  4. Resolve (SessionResolver → session)
  5. Plan (RunPlanner → RunRequest)
  6. Execute (RunExecutor → RunOutcome)
  7. Deliver (NotificationAdapter → NotificationResult)

Legacy Loop (still active):
  Trigger (cron/webhook/fs/manual)
    → EventQueue
      → Envelope (normalize + validate + dedupe)
        → Router (match rules → RoutingDecision)
          → ConcurrencyGate
            → PermissionGate
              → Dispatcher (execute)
                → RunSupervisor (budget enforcement)
                  → LLM call → Tool loop → Summary
                    → AuditLog + DLQ (on failure)
```

## KEY PATTERNS

- **Supervisor/Worker Split**: Separates orchestration decisions (ConversationSupervisor, ExecutionSupervisor) from execution (RunWorker).
  - **ConversationSupervisor**: User-facing orchestration. Handles requirement gathering, clarification, plan authoring, and approval gate. Session mode: `reuse` (if exists) or `persistent`.
  - **ExecutionSupervisor**: Execution orchestration. Handles task decomposition, assignment, accept/reject, re-dispatch loop. Session mode: `persistent`. Internal-only (no direct external entry).
  - **RunWorker**: Shared execution primitive. Handles LLM/tool loop, retry, budget, session lifecycle, state transitions. Used by both supervisors and tools (SubagentWorker, DispatchCoordinator).
  - **Execution flow**: External events → ConversationSupervisor → (after approval) → ExecutionSupervisor → RunWorker
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
- **Dispatch Consolidation**: `dispatch.ts` is now a thin wrapper (118 lines) that delegates to `ExecutionSupervisor.executeDispatch()`. Core DAG execution, review gate, and handoff logic lives in ExecutionSupervisor (1322 lines).
- **FileLock Independence**: File locking logic extracted to `loop/file-lock.ts` for reuse across dispatch and other coordinators.
- **TaskManager**: `TaskManager.create()` → `TaskManager.trigger(taskId, signal)` → returns `{ runId }` or `{ error }`.
- **RunWorker.run()**: Main execution entry. Takes `{ taskId, runId, maxRetries, sessionMode, sessionId, maxSubagentDepth, currentDepth }` + `{ llm, input, toolExecutor }`. Returns `{ success, summary, error }`.
- **Orchestrator.run()**: Compatibility facade. Delegates to `RunWorker.run()`. Use `RunWorker.run()` directly for new code.
- **ConfigManager.create()**: Deep-merge overrides into defaults. Validated with `ConfigManager.validate()`.
- **State machine**: TaskStateMachine enforces valid transitions (e.g., `pending→active→completed`).

## ANTI-PATTERNS

- **Orchestrator.run() REMOVED** — `orchestration.ts` has been deleted. Use `RunWorker.run()` directly for all execution. The compatibility facade no longer exists.
- `supervisor.ts` in loop/ is older — `run-supervisor.ts` is the current implementation. Do NOT extend supervisor.ts.
- QueueMetrics name conflict between `trigger/queue.ts` and `loop/observability.ts` — re-exported with aliases (`TriggerQueueMetrics`, `LoopQueueMetrics`) in index.ts.
- `require()` was used in `summary.ts` at one point — fixed. Keep ESM imports only.
- Do NOT reference `graph.ts` or `routing.ts` — these were removed in Phase 1 migration to Dynamic Supervisor.
