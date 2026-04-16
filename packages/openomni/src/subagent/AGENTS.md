# Subagent Module

Session-backed execution runtime for subagents. `SubagentRuntime` runs one agent turn per call with a per-session lock, persisting transcripts into `@openomni/session` and lifecycle via `WorkerRun`. `BackgroundManager` wraps the runtime for fire-and-forget concurrent work. `SubagentConsultation` handles advisory calls to other agents.

## Files

| File | Role |
| --- | --- |
| `runtime.ts` | `SubagentRuntime.spawn / spawnBackground / send / resume / cancel / wait` — session-locked subagent execution, timeouts, abort handling, transcript persistence |
| `background-manager.ts` | `BackgroundManager.create(config?)` — fire-and-forget task manager with concurrency / depth / descendant limits and bus-event driven completion |
| `consultation.ts` | `SubagentConsultation.consult(request, config)` — advisory queries (fresh-session or active-session), published as `Subagent.Events.WorkerConsultation*` |
| `abort-registry.ts` | Per-session `AbortController` registry used by the runtime for cooperative cancellation |
| `index.ts` | Barrel export (runtime + consultation + background manager) |

## Composition

```
SubagentRuntime
  ├─ withSessionLock(sessionId, fn)       // serial execution per session
  ├─ WorkerRun.create / updateStatus      // event-sourced run records
  ├─ ChatAgent.create(...).run(...)       // delegates to @openomni/agent
  ├─ Session.addMessage / addPart         // persist transcript (user + assistant + tool parts)
  ├─ AbortControllerRegistry              // signal + controller per session
  └─ Bus.publish(Subagent.Events.*)       // worker lifecycle visibility

BackgroundManager
  ├─ launch(input) → Subagent.BackgroundTask    // enforces maxConcurrentPerAgent / Total / depth / descendants
  ├─ SubagentRuntime.spawnBackground(...)      // reuses the same locked execution path
  ├─ Bus.subscribe(WorkerRunCompleted/Failed)  // marks task complete / failed + publishes BackgroundTask.* events
  └─ cancel(taskId) / cleanup()                // abort + TTL eviction

SubagentConsultation
  ├─ fresh-session mode  → Session.createChild + WorkerRun + ChatAgent.run
  └─ active-session mode → ChatAgent.run with target session context (no durable write)
```

## Worker Run Lifecycle

`WorkerRun.status` transitions mirror `Subagent.WorkerRunStatus` in `@openomni/protocol`:

```
queued → starting → running → succeeded
                          └─ failed
                          └─ cancelled
                          └─ interrupted
                          └─ waiting_input → running (resumeCount++)
```

Terminal statuses: `succeeded | failed | cancelled | interrupted`. `finalizeRun()` reconciles meta status at the end of every run.

## Timeouts

- `softTimeoutMs` — emits `Subagent.Events.WorkerRunFailed` with `error: "soft timeout exceeded"` but does not abort.
- `hardTimeoutMs` — marks the run `interrupted`, aborts the session, then publishes `WorkerRunFailed`.
- `cancel()` with `hardTimeoutMs` (default 10s) — aborts the controller and waits for the abort entry to clear before marking `cancelled`.

## BackgroundManager Limits

Default config (override via `BackgroundManager.create(config)`):

- `maxConcurrentPerAgent = 3`
- `maxConcurrentTotal = 10`
- `maxDepth = 5` (hops from the original parent session)
- `maxDescendants = 10` (tasks sharing the same `parentSessionId`)
- `taskTtlMs = 1_800_000` (30 minutes after completion)

Tasks that exceed any limit fail immediately with a descriptive reason instead of being queued.

## Events Published

- `Subagent.Events.WorkerSessionSpawned` — new child session created
- `Subagent.Events.WorkerRunStarted / WorkerRunCompleted / WorkerRunFailed` — run lifecycle
- `Subagent.Events.WorkerSessionResumed / WorkerSessionCancelled` — session lifecycle
- `Subagent.Events.WorkerConsultationRequested / WorkerConsultationCompleted` — consultations
- `Subagent.Events.BackgroundTaskLaunched / BackgroundTaskCompleted / BackgroundTaskFailed / BackgroundTaskCancelled` — background manager lifecycle

All events use `BusEvent.define()` definitions in `@openomni/protocol/subagent` and carry the standard `BaseEvent` correlation fields plus a domain-specific `payload`.

## When NOT to use this module

- For a pure ReAct call without session persistence, use `ChatAgent.create().run()` from `@openomni/agent` directly.
- For ingestion of external events, use `IngressEngine` in `../ingress/` — it will internally dispatch to `ChatAgent` (direct mode) or `PlanAgent` (plan mode). `SubagentRuntime` is for worker-style delegated execution.
