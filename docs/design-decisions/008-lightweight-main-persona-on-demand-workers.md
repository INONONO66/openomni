# ADR-008: Lightweight Resident with On-Demand Worker Processes

**Status**: Proposed

## Context

The current coordinator spawns a fixed pool of 8 worker processes at server startup. Each worker loads Bun + SQLite + LLM SDK, resulting in ~9 processes always running regardless of workload. This is excessive for a personal server.

Meanwhile, the product direction (ADR-005, `docs/core-model.md`) calls for a Resident that handles conversation directly and delegates heavy work to Workers. The current architecture routes ALL execution through the coordinator, even simple conversation.

Comparable systems:
- **Hermes**: single gateway process, in-process session management, lightweight
- **opencode**: independent per-task processes, each handling one session
- **Claude Code team mode**: tmux-spawned independent CLI instances

OpenOmni should combine the best of both: Resident runs Hermes-style (in-process, lightweight, always-on), while heavy work spawns opencode-style independent worker processes on demand.

## Decision

OpenOmni will adopt a two-tier execution model:

1. **Resident Runtime** — runs in the server process, handles conversation directly without coordinator dispatch.
2. **On-Demand Worker Manager** — replaces the fixed worker pool. Spawns worker processes only when needed, kills them when done or idle.

### Execution Model

```text
Server Process (always on, lightweight)
├── ResidentRuntime
│   ├── conversation handling (in-process)
│   ├── intent classification (direct vs delegate)
│   ├── worker lifecycle management
│   └── worker ask/answer mediation
│
├── OnDemandWorkerManager
│   ├── spawn worker process (on demand)
│   ├── IPC via UNIX socket (reuse existing)
│   ├── idle timeout → kill
│   └── crash recovery → mark interrupted
│
└── IngressEngine
    ├── target: resident → ResidentRuntime (in-process)
    ├── target: worker:{id} → direct to worker (IPC)
    └── authority check (user/Resident only create workers)
```

### Worker Process Lifecycle

Workers are disposable. Sessions are durable.

```text
Process: none → starting → ready → busy → idle → stopping → exited
                                              ↓
                                         (idle timeout)
                                              ↓
                                           killed

Session: persisted in SQLite, survives process death
Resume:  new process + existing sessionId + transcript reload
```

### Communication

```text
User ←→ Resident (in-process, zero IPC)
Resident → Worker: spawn, cancel, deliver message (IPC)
Worker → Resident: ask_main, heartbeat, run_completed (IPC)
User → Worker: direct inbound (ingress routes directly, Resident observes via events)
User: "show me Worker A" → tail persisted bus events (not live subscription)
```

## Rationale

### Why not keep the fixed pool?

- 9 processes for a personal server is wasteful
- Most time is spent in conversation, which needs zero workers
- Workers should exist only when work exists

### Why Resident in-process?

- Conversation is lightweight (single LLM call, no file ops)
- Eliminates IPC round-trip for 90% of interactions
- Resident needs instant access to memory, session state, worker registry
- Hermes proves this model works at scale

### Why on-demand workers?

- Same isolation benefits as current coordinator (separate process, crash recovery)
- Resource usage proportional to actual workload (0 workers when idle)
- Each worker is like an opencode session — independent, focused, disposable
- Session persistence means resume is cheap (new process, load transcript)

### Why UNIX socket IPC (not stdio)?

- Already implemented and tested
- Bidirectional (needed for ask_main, cancel, tool_call proxying)
- Authenticated (per-worker token)
- Supports multiple concurrent workers
- stdio only works for one-shot fire-and-forget

## Architecture

### Module Boundaries

| Module | Responsibility |
| --- | --- |
| `packages/protocol` | SessionKind, worker IPC method schemas, ask events |
| `packages/openomni/src/resident/` | ResidentRuntime, intent routing, writeback policy |
| `packages/openomni/src/ingress/` | Target resolution: resident vs worker:{id}, authority validation |
| `packages/coordinator/src/worker-manager/` | Process spawn/kill, socket auth, idle timeout, heartbeat, active worker registry |
| `apps/server/src/bootstrap/` | Wire ResidentRuntime + WorkerManager + channels |
| `apps/server/src/execution/worker-entry.ts` | Worker process entrypoint (mostly unchanged, add ask-main) |

### State Machines

#### Worker Process (non-durable, runtime only)

```text
none
  → starting       Bun.spawn worker-entry, create socket token
  → ready          IPC bootstrap handshake complete
  → busy           active run in progress
  → idle           no active run, idle timer armed
  → stopping       SIGTERM sent (graceful) or SIGKILL (force)
  → exited         process gone

busy → crashed     unexpected exit detected
crashed → none     mark active run interrupted, session remains resumable
```

#### Worker Run (durable, SQLite)

```text
queued → starting → running → succeeded
                           → failed
                           → waiting_input (ask escalated to user)
                           → cancelled
                           → interrupted (crash/timeout)

waiting_input → running    (user/Resident answered, new process resumes)
interrupted → running      (explicit resume with new process)
```

### IPC Protocol Additions

Existing methods kept as-is:
- `coordinator.bootstrap`, `coordinator.spawn_run`, `coordinator.cancel_run`
- `worker.heartbeat`, `worker.tool_call`, `worker.run_completed`

New methods:

```text
server → worker:
  worker.deliver_message     Direct user/Resident message to active worker
  worker.shutdown_idle       Graceful idle shutdown request

worker → server:
  worker.ask_main            Worker needs Resident/user decision
    { askId, sessionId, runId, question, urgency, timeoutMs }
```

### Ask-Resident Flow

1. Worker sends `worker.ask_main` via IPC
2. Server persists ask event in worker session
3. ResidentRuntime evaluates:
   - Can answer autonomously → respond immediately via IPC
   - Cannot answer → escalate to user, mark run `waiting_input`
4. If escalated: worker receives `pending` response, stops gracefully
5. When user answers: ingress appends answer to worker session, WorkerManager spawns new process to resume

### Direct User → Worker Inbound

1. User targets worker explicitly (e.g., "Worker A: change approach to X")
2. IngressEngine validates authority (only user may direct-target)
3. Routes directly to worker via `worker.deliver_message` IPC
4. Resident observes via session lineage and bus events (not in forwarding path)

### Passthrough (Observability)

- NOT a subscription system
- User explicitly requests: "show me Worker A"
- Implementation: tail persisted bus events / session messages for that worker's sessionId
- Stop when user says stop or switches context
- No permanent event forwarding infrastructure needed

## Worker Scope

Workers are not limited to coding. Any heavy or isolated task qualifies:

| Domain | Example |
| --- | --- |
| Development | Feature implementation, bug fixing, refactoring |
| Research | Paper analysis, tech comparison, market research |
| Writing | Blog posts, documentation, translations |
| Data | Crawling, analysis, visualization |
| Operations | Deployment, monitoring setup, CI/CD |
| Any isolated task | Resident decides "this needs focused independent work" |

Each worker can have different tool sets, system prompts, and workspace contexts appropriate to its domain.

## Migration Path

### Keep (reuse as-is)
- `packages/coordinator/src/ipc/*` — framing, codec, server, client
- `apps/server/src/execution/worker-entry.ts` — worker execution core
- `packages/coordinator/src/recovery/` — interrupted run recovery
- `packages/coordinator/src/credentials/` — credential injection
- `packages/coordinator/src/tool-permission/` — tool permission policy
- `packages/openomni/src/subagent/` — SubagentRuntime (in-process within worker)
- All session/bus/WorkerRun infrastructure

### Rewrite
- `packages/coordinator/src/worker-pool/pool.ts` → `worker-manager/manager.ts`
- `packages/coordinator/src/worker-pool/supervisor.ts` → `worker-manager/worker-handle.ts` (per-worker, not pooled)
- `packages/coordinator/src/worker-pool/session-routing.ts` → remove (1:1 session:worker, no routing needed)

### Add
- `packages/openomni/src/resident/runtime.ts` — ResidentRuntime
- `packages/openomni/src/resident/intent.ts` — classify direct vs delegate
- `packages/openomni/src/ingress/target-resolver.ts` — resident vs worker routing
- IPC method: `worker.ask_main`, `worker.deliver_message`
- Protocol: `SessionKind` enum (conversation, work, self-loop)

### Remove
- Fixed pool initialization in server bootstrap
- `SessionRouting` (affinity map no longer needed)
- Assumption that all execution goes through coordinator dispatch

## Constraints

- SQLite WAL mode must handle multi-process writes (server + workers)
- Resident conversation history must NOT absorb raw worker transcripts (per ADR-005)
- Worker count is bounded by available system resources, not a fixed config
- Only user and Resident may create workers (controlled inbound authority)

## Consequences

### Positive
- Idle server = 1 process (Resident only). Minimal resource usage.
- Workers scale with actual workload (0 when idle, N when busy)
- Resident conversation is instant (no IPC overhead)
- Clean separation: conversation (Resident) vs work (Workers)
- Resume is cheap: new process + existing session
- Matches ADR-005 persona workforce model directly

### Negative
- Spawn latency: first message to new worker has process startup cost (~1-2s)
- Slightly more complex than pure in-process model (IPC still needed for workers)
- SQLite concurrent access needs careful configuration
- Worker idle timeout tuning needed (too short = frequent respawns, too long = wasted memory)

## Non-goals

- This ADR does not implement persona lifecycle (promotion/retirement)
- This ADR does not implement Anamnesis/long-term memory
- This ADR does not implement distilled writeback policy
- This ADR does not make workers multi-tenant (one session per worker)
- This ADR does not add a web dashboard or TUI (but bus events enable them later)

## Open Questions

1. Should idle timeout be configurable per-worker or global?
2. Should Resident in-process agent share the same ChatAgent code path or have a simplified loop?
3. Maximum concurrent worker count — hard limit or soft pressure?
4. Should worker spawn be lazy (first message triggers) or eager (Resident decides immediately)?
