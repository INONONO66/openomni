# packages/coordinator

Multiprocess execution coordinator runtime. This package owns on-demand worker process lifecycle, primitive run delivery, and worker supervision used by OpenOmni/server execution (the IPC transport itself is `@openomni/ipc` since #496) (interrupted-run recovery lives server-side in `apps/server/src/execution/recovery.ts` since #477). Per the runtime substrate design (see `docs/architecture.md`; ADR-008 retired into it): workers spawn on demand and idle-shutdown; there is no fixed pool.

The coordinator is an executor, not the communication kernel. It must not decide actor authority, PendingInteraction/PendingAsk routing, channel/session targets, worker grants, or writeback. Those product semantics belong in `@openomni/openomni`.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── worker-manager/       # ⭐ LIVE: worker pool — spawn on demand, slots, idle shutdown
└── worker-supervision/   # Worker supervisor internals (IPC client side via @openomni/ipc)
```

## DEPENDENCIES

Depends on `@openomni/protocol` and `@openomni/ipc` **only** — a ring-2 process driver (#462; IPC transport extracted in #496). Every environment edge (ledger event sink, tool relay, inbound-wait bridge) is injected as a `WorkerPorts` object by the composition root (`apps/server/src/bootstrap`); the CI dep ratchet (`script/check-deps.ts`) enforces protocol+ipc-only. Runtime execution wiring lives in `apps/server/src/execution/worker-entry.ts`, so the coordinator receives a worker script path and stays independent of `@openomni/session`, `@openomni/agent`, `@openomni/llm`, and `@openomni/openomni`.

## MODULES

| Module | Purpose |
|--------|---------|
| `worker-manager/worker-pool.ts` | **Primary API.** One pool module (#462 step 4: the former manager/slot-coordinator split is merged; the class is not exported). `createWorkerManager(config, ports)`: one verb — `deliver(runId, task)` (plus `cancel`/`send`/`stats`), typed `WorkerDeliveryError` rejections, session-affinity optimization, spawn on demand up to `maxActiveWorkers` (default 10), waiter queue when saturated, idle shutdown (`idleShutdownMs`, default 600s), generation-tracked restarts. Emits `WorkerDriver` lifecycle events (`worker.spawned/ready/exited/restarted`, `run.delivered/settled`, `worker.queue_saturated`) through the injected events sink; wall-time is driver physics — ceiling = budget + margin (unlimited/absent budgets get the 600s backstop), breach = SIGKILL + `wall_time_exceeded` (#462 step 5) |
| `worker-supervision/supervisor.ts` | Per-worker process lifecycle: spawn, bootstrap handshake, restart generations, stop. Constructed from a `WorkerSupervisorOptions` object; the worker RPCs (`deliver`/`cancel`/`send`) live here (#462 step 4) |
| (`@openomni/ipc`) | Request/response framing, bidirectional client/server transport, protocol errors — standalone package since #496, consumed here by `worker-supervision/` |


## WORKER LIFECYCLE (worker-manager)

```

Session affinity here is an execution optimization only. Do not use it as product routing authority. OpenOmni chooses the target run/session; coordinator only delivers to the primitive worker/run requested by its caller.
deliver(runId, task)
  → reject (typed WorkerDeliveryError) if stopping / duplicate runId / queue full / slot wait timeout
  → acquireSlot(task.sessionId): free slot | new worker (≤ maxActiveWorkers) | wait in queue
  → slot.load++, clear idle timer
  → ensureSupervisor() (created on demand; generation check across restarts)
  → publish WorkerDriver.RunDelivered
  → supervisor.deliver → result, publish WorkerDriver.RunSettled (completed | interrupted | error | cancelled)
  → slot.load--; if 0: release one waiter, scheduleIdleShutdown()
       idleShutdownMs elapsed with load 0 → kill worker, forget slot
```

Observability is ledger events, not push maps (#462 §4): the supervisor publishes `WorkerDriver.Spawned/Ready/Exited/Restarted` and the pool publishes `RunDelivered/RunSettled/QueueSaturated` through the injected `BusEvent.Sink` — worker lifecycle is reconstructable from these events alone, including cancellation: a cancelled run settles with outcome `cancelled` whether the cancel landed before delivery (no `RunDelivered` row, `durationMs` 0) or mid-flight. Wall-time is enforced in the driver: a delivery whose RPC exceeds `budget.maxWallTimeMs` plus a margin (`OPENOMNI_DELIVER_MARGIN_MS`, default 30s) gets the worker SIGKILLed and rejects with `wall_time_exceeded`; the run settles as `interrupted`. A worker that spawns but never serves IPC is killed at the connect deadline, and consecutive fast crashes trip a circuit breaker that suspends restarts (terminal `Operational.Warn`; the next delivery replaces the supervisor). The `DeliverTask` shape (`{ sessionId } & Record<string, unknown>`) is package-internal — no external importer exists.

## CONSUMER

`apps/server/src/execution/coordinator.ts` is the live consumer: `createExecutionCoordinator()` wraps `createWorkerManager(config, ports)` (config mapping: `maxWorkers` → `maxActiveWorkers`, `workerIdleTimeoutMs` → `idleShutdownMs`; ports: `events` = `Bus.publish`, `toolRelay`, `inboundWait`) and owns delivery, cancellation, message send, stats, and recovery wiring (recovery itself lives server-side in `apps/server/src/execution/recovery.ts`).

Barrel exports (`src/index.ts`): `createWorkerManager` (live; the pool class itself is not exported), plus types. `createIpcServer` moved to `@openomni/ipc` (#496) — the coordinator re-exports no IPC surface. `worker-supervision/` is internal — not exported from the root barrel.

## TESTS

Tests are split by module: inline supervisor tests live beside source (IPC transport tests moved to `packages/ipc/test/` in #496), while `test/` covers `worker-manager/` delivery/crash behavior, `worker-supervision/` supervisor contracts, barrel contracts, recovery, and harness smoke coverage.

## ANTI-PATTERNS

- Do NOT deep-import from `@openomni/*/src/*`; use package barrels only.
- Do NOT add empty catch blocks; coordinator needs explicit degradation behavior.
- Do NOT add generic catch-all files like `utils.ts` or `helpers.ts`.
- Do NOT put session-backed orchestration policy here; coordinator executes and recovers worker processes, while `@openomni/openomni` owns orchestration semantics.
- Do NOT add worker-pool compatibility facades; target `worker-manager` directly.
- Do NOT add actor, channel, PendingInteraction, PendingAsk, WorkerGrant, SurfaceKey, or writeback logic here.
