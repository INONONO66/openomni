# packages/agent

Core orchestration package. Multi-agent task system with event-driven loop, graph-based routing, triggers, and conversation handling. Largest package (~35 source files). Depends on protocol, session, and llm.

## STRUCTURE

```
src/
├── index.ts           # Public API barrel
├── config.ts          # AutonomousLoopConfig + ConfigManager (defaults, merge, validate)
├── agent/             # Agent identity, graph, routing, messaging
│   ├── profile.ts     # AgentProfile, AgentIdentity, AgentRuntime, AgentRegistry
│   ├── graph.ts       # AgentGraph — DAG of nodes + edges, validation functions
│   ├── routing.ts     # RouteResolver — evaluates RouteConditions against context
│   ├── communication.ts  # AgentMessenger — inter-agent message delivery
│   └── supervision.ts # Agent supervision patterns
├── task/              # Task lifecycle management
│   ├── types.ts       # Task, TaskRun, TriggerSignal Zod schemas
│   ├── manager.ts     # TaskManager — create, trigger, getRun, state transitions
│   ├── storage.ts     # TaskStorage + InMemoryTaskStore
│   ├── state-machine.ts  # TaskStateMachine — valid status transitions
│   ├── checkpoint.ts  # CheckpointManager — save/restore run state
│   └── recovery.ts    # CrashRecovery — detect and recover failed runs
├── loop/              # Autonomous execution loop
│   ├── envelope.ts    # EventEnvelope — normalize + validate incoming events
│   ├── router.ts      # Router — match events to rules, produce RoutingDecision
│   ├── dispatcher.ts  # Dispatcher — execute routed events
│   ├── concurrency.ts # ConcurrencyGate — lane-based concurrency control
│   ├── permission.ts  # PermissionGate — ask/notify/deny policy enforcement
│   ├── run-supervisor.ts  # RunSupervisor — budget enforcement (time, turns, tool calls)
│   ├── orchestration.ts   # Orchestrator.run() — full pipeline: route→dispatch→tool loop
│   ├── dlq.ts         # DeadLetterQueue — failed event storage
│   ├── summary.ts     # SummaryDelivery — post-run summary generation
│   ├── audit.ts       # AuditLog — event audit trail
│   ├── observability.ts   # Observability — metrics collection
│   └── supervisor.ts  # Higher-level supervisor (deprecated — use run-supervisor)
├── trigger/           # External event sources
│   ├── scheduler.ts   # Scheduler + CronParser
│   ├── queue.ts       # EventQueue — priority queue with drop policies
│   ├── watcher.ts     # FilesystemWatcher
│   └── webhook.ts     # WebhookWatcher (abstract) + SimpleWebhookWatcher
└── conversation/
    └── handler.ts     # ConversationRequestHandler — inline-vs-task heuristics
```

## PIPELINE FLOW

```
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

- **TaskManager**: `TaskManager.create()` → `TaskManager.trigger(taskId, signal)` → returns `{ runId }` or `{ error }`. Manages Task + TaskRun lifecycle.
- **AgentGraph**: DAG with `AgentNode` (kinds: llm, router, tool, human) and `AgentEdge` (conditions: always, llm_router, output_match, etc.). Validated with `validateAgentGraph()`.
- **Orchestrator.run()**: Main entry. Takes `{ taskId, runId, maxRetries }` + `{ llm, input, toolExecutor }`. Returns `{ success, summary, error? }`.
- **ConfigManager.create()**: Deep-merge overrides into defaults. Validated with `ConfigManager.validate()`.
- **Idempotency**: Event-level dedup in Router via idempotency keys.
- **State machine**: TaskStateMachine enforces valid transitions (e.g., `pending→active→completed`).

## ANTI-PATTERNS

- `supervisor.ts` in loop/ is older — `run-supervisor.ts` is the current implementation. Do NOT extend supervisor.ts.
- QueueMetrics name conflict between `trigger/queue.ts` and `loop/observability.ts` — re-exported with aliases (`TriggerQueueMetrics`, `LoopQueueMetrics`) in index.ts.
- `require()` was used in `summary.ts` at one point — fixed. Keep ESM imports only.
