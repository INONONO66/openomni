# packages/coordinator

Multiprocess execution coordinator runtime. This package owns on-demand worker process lifecycle, IPC transport, primitive run delivery, recovery, and worker supervision used by OpenOmni/server execution. Per [ADR-008](../../docs/design-decisions/008-lightweight-main-persona-on-demand-workers.md) (accepted): workers spawn on demand and idle-shutdown; there is no fixed pool.

The coordinator is an executor, not the communication kernel. It must not decide actor authority, PendingInteraction/PendingAsk routing, channel/session targets, worker grants, or writeback policy. Those product semantics belong in `@openomni/openomni`.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── ipc/                  # Unix socket transport + framing + protocol errors
├── recovery/             # Interrupted worker run recovery
├── worker-manager/       # ⭐ LIVE: OnDemandWorkerManager — spawn on demand, slots, idle shutdown
└── worker-supervision/   # Worker supervisor internals plus SessionRouting helper
```

## DEPENDENCIES

Depends on `@openomni/protocol` and `@openomni/session`. Runtime execution wiring lives in `apps/server/src/execution/worker-entry.ts`, so the coordinator receives a worker script path and stays independent of `@openomni/agent`, `@openomni/llm`, and `@openomni/openomni`.

## MODULES

| Module | Purpose |
|--------|---------|
| `worker-manager/manager.ts` | **Primary API.** `createWorkerManager()` / `OnDemandWorkerManager`: slot-based run dispatch, session-affinity optimization, spawn on demand up to `maxActiveWorkers` (default 10), waiter queue when saturated, idle shutdown (`idleShutdownMs`, default 600s), generation-tracked restarts |
| `worker-supervision/supervisor.ts` | Per-worker process lifecycle: spawn, bootstrap handshake, restart generations, stop |
| `worker-supervision/session-routing.ts` | Session affinity helper used by `worker-manager`; session-affinity `route/complete` behavior remains test-covered |
| `ipc/*` | Request/response framing, bidirectional client/server transport, protocol errors |
| `recovery/index.ts` | `recoverInterruptedRuns()` — marks interrupted worker runs failed after restart |

## WORKER LIFECYCLE (worker-manager)

```

Session affinity here is an execution optimization only. Do not use it as product routing authority. OpenOmni chooses the target run/session; coordinator only delivers to the primitive worker/run requested by its caller.
dispatch(runId)
  → reject if stopping / duplicate runId
  → acquireSlot(): free slot | new worker (≤ maxActiveWorkers) | wait in queue
  → slot.load++, clear idle timer
  → ensureSupervisor() (created on demand; generation check across restarts)
  → dispatch to supervisor → result
  → slot.load--; if 0: release one waiter, scheduleIdleShutdown()
       idleShutdownMs elapsed with load 0 → kill worker, forget slot
```

## CONSUMER

`apps/server/src/execution/coordinator.ts` is the live consumer: `createExecutionCoordinator()` wraps `createWorkerManager()` (config mapping: `maxWorkers` → `maxActiveWorkers`, `workerIdleTimeoutMs` → `idleShutdownMs`; callbacks `onToolCall`, `onInboundWait`, `onWorkerSnapshot`) and owns dispatch, cancellation, message delivery, stats, and recovery wiring.

Barrel exports (`src/index.ts`): `createWorkerManager` / `OnDemandWorkerManager` (live), `createIpcServer`, `recoverInterruptedRuns`, plus types. `worker-supervision/` is internal — not exported from the root barrel.

## TESTS

Tests are split by module: inline IPC/supervisor tests live beside source, while `test/` covers `worker-manager/` dispatch/crash behavior, `worker-supervision/` supervisor contracts, SessionRouting behavior, barrel contracts, recovery, and harness smoke coverage.

## ANTI-PATTERNS

- Do NOT deep-import from `@openomni/*/src/*`; use package barrels only.
- Do NOT add empty catch blocks; coordinator needs explicit degradation behavior.
- Do NOT add generic catch-all files like `utils.ts` or `helpers.ts`.
- Do NOT put session-backed orchestration policy here; coordinator executes and recovers worker processes, while `@openomni/openomni` owns orchestration semantics.
- Do NOT add worker-pool compatibility facades; target `worker-manager` directly.
- Do NOT add actor, channel, PendingInteraction, PendingAsk, WorkerGrant, SurfaceKey, or writeback logic here.
