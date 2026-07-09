# packages/coordinator

Multiprocess execution coordinator runtime. This package owns on-demand worker process lifecycle, IPC transport, primitive run delivery, and worker supervision used by OpenOmni/server execution (interrupted-run recovery lives server-side in `apps/server/src/execution/recovery.ts` since #477). Per the runtime substrate design (see `docs/architecture.md`; ADR-008 retired into it): workers spawn on demand and idle-shutdown; there is no fixed pool.

The coordinator is an executor, not the communication kernel. It must not decide actor authority, PendingInteraction/PendingAsk routing, channel/session targets, worker grants, or writeback policy. Those product semantics belong in `@openomni/openomni`.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── ipc/                  # Unix socket transport + framing + protocol errors
├── worker-manager/       # ⭐ LIVE: worker pool — spawn on demand, slots, idle shutdown
└── worker-supervision/   # Worker supervisor internals
```

## DEPENDENCIES

Depends on `@openomni/protocol` **only** — a ring-2 process driver (#462). Every environment edge (ledger event sink, tool relay, inbound-wait bridge) is injected as a `WorkerPorts` object by the composition root (`apps/server/src/bootstrap`); the CI dep ratchet (`script/check-deps.ts`) enforces protocol-only. Runtime execution wiring lives in `apps/server/src/execution/worker-entry.ts`, so the coordinator receives a worker script path and stays independent of `@openomni/session`, `@openomni/agent`, `@openomni/llm`, and `@openomni/openomni`.

## MODULES

| Module | Purpose |
|--------|---------|
| `worker-manager/worker-pool.ts` | **Primary API.** One pool module (#462 step 4: the former manager/slot-coordinator split is merged; the class is not exported). `createWorkerManager(config, ports)`: one verb — `deliver(runId, task)` (plus `cancel`/`send`/`stats`), typed `WorkerDeliveryError` rejections, session-affinity optimization, spawn on demand up to `maxActiveWorkers` (default 10), waiter queue when saturated, idle shutdown (`idleShutdownMs`, default 600s), generation-tracked restarts. Emits `WorkerDriver` lifecycle events (`worker.spawned/ready/exited/restarted`, `run.delivered/settled`, `worker.queue_saturated`) through the injected events sink; wall-time is driver physics — ceiling = budget + margin (unlimited/absent budgets get the 600s backstop), breach = SIGKILL + `wall_time_exceeded` (#462 step 5) |
| `worker-supervision/supervisor.ts` | Per-worker process lifecycle: spawn, bootstrap handshake, restart generations, stop. Constructed from a `WorkerSupervisorOptions` object; the worker RPCs (`deliver`/`cancel`/`send`) live here (#462 step 4) |
| `ipc/*` | Request/response framing, bidirectional client/server transport, protocol errors |


## WORKER LIFECYCLE (worker-manager)

```

Session affinity here is an execution optimization only. Do not use it as product routing authority. OpenOmni chooses the target run/session; coordinator only delivers to the primitive worker/run requested by its caller.
deliver(runId, task)
  → reject (typed WorkerDeliveryError) if stopping / duplicate runId / queue full / slot wait timeout
  → acquireSlot(task.sessionId): free slot | new worker (≤ maxActiveWorkers) | wait in queue
  → slot.load++, clear idle timer
  → ensureSupervisor() (created on demand; generation check across restarts)
  → supervisor.deliver → result
  → slot.load--; if 0: release one waiter, scheduleIdleShutdown()
       idleShutdownMs elapsed with load 0 → kill worker, forget slot
```

## CONSUMER

`apps/server/src/execution/coordinator.ts` is the live consumer: `createExecutionCoordinator()` wraps `createWorkerManager(config, ports)` (config mapping: `maxWorkers` → `maxActiveWorkers`, `workerIdleTimeoutMs` → `idleShutdownMs`; ports: `events` = `Bus.publish`, `toolRelay`, `inboundWait`) and owns delivery, cancellation, message send, stats, and recovery wiring (recovery itself lives server-side in `apps/server/src/execution/recovery.ts`).

Barrel exports (`src/index.ts`): `createWorkerManager` (live; the pool class itself is not exported), `createIpcServer`, plus types. `worker-supervision/` is internal — not exported from the root barrel.

## TESTS

Tests are split by module: inline IPC/supervisor tests live beside source, while `test/` covers `worker-manager/` delivery/crash behavior, `worker-supervision/` supervisor contracts, barrel contracts, recovery, and harness smoke coverage.

## ANTI-PATTERNS

- Do NOT deep-import from `@openomni/*/src/*`; use package barrels only.
- Do NOT add empty catch blocks; coordinator needs explicit degradation behavior.
- Do NOT add generic catch-all files like `utils.ts` or `helpers.ts`.
- Do NOT put session-backed orchestration policy here; coordinator executes and recovers worker processes, while `@openomni/openomni` owns orchestration semantics.
- Do NOT add worker-pool compatibility facades; target `worker-manager` directly.
- Do NOT add actor, channel, PendingInteraction, PendingAsk, WorkerGrant, SurfaceKey, or writeback logic here.
