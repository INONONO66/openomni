# packages/coordinator

Multiprocess execution coordinator runtime. This package owns on-demand worker lifecycle, IPC transport, recovery, credentials/policy helpers, and the worker supervision used by server-side dispatch. Per [ADR-008](../../docs/design-decisions/008-lightweight-main-persona-on-demand-workers.md) (accepted): workers spawn on demand and idle-shutdown; there is no fixed pool.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── credentials/          # Worker credential filtering and injection (internal; not in barrel)
├── ipc/                  # Unix socket transport + framing + protocol errors
├── recovery/             # Interrupted worker run recovery
├── tool-permission/      # Non-interactive permission policy + audit log (internal; not in barrel)
├── worker-manager/       # ⭐ LIVE: OnDemandWorkerManager — spawn on demand, slots, idle shutdown
└── worker-pool/          # LEGACY facade (pool.ts wraps createWorkerManager) + supervisor + session routing
```

## DEPENDENCIES

Depends on `@openomni/protocol`, `@openomni/session`, `@openomni/agent`, and `@openomni/openomni` because the coordinator reconstructs real execution in worker processes.

## MODULES

| Module | Purpose |
|--------|---------|
| `worker-manager/manager.ts` | **Primary API.** `createWorkerManager()` / `OnDemandWorkerManager`: slot-based dispatch, session affinity, spawn on demand up to `maxActiveWorkers` (default 10), waiter queue when saturated, idle shutdown (`idleShutdownMs`, default 600s), generation-tracked restarts |
| `worker-pool/pool.ts` | Legacy facade — `createWorkerPool()` delegates to `createWorkerManager()` (`size` → `maxActiveWorkers` alias). Kept for compatibility; pending removal (see implementation-status) |
| `worker-pool/supervisor.ts` | Per-worker process lifecycle: spawn, bootstrap handshake, restart generations, stop |
| `worker-pool/session-routing.ts` | Session-tree affinity routing |
| `ipc/*` | Request/response framing, bidirectional client/server transport, protocol errors |
| `recovery/index.ts` | `recoverInterruptedRuns()` — marks interrupted worker runs failed after restart |
| `credentials/store.ts` / `credentials/injector.ts` | Loads stored credentials, filters by provider prefix, injects provider-scoped credentials into workers |
| `tool-permission/*` | Policy load + audit logging for non-interactive tool decisions |

## WORKER LIFECYCLE (worker-manager)

```
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

Barrel exports (`src/index.ts`): `createWorkerManager` / `OnDemandWorkerManager` (live), `createWorkerPool` (legacy), `createIpcServer`, `recoverInterruptedRuns`, plus types. `credentials/` and `tool-permission/` are internal — not exported from the barrel.

## TESTS

13 files: 3 inline (`src/ipc/framing.test.ts`, `src/ipc/ipc-bidirectional.test.ts`, `src/worker-pool/supervisor.test.ts`) + 10 under `test/` split by module (`worker-manager/`, `worker-pool/` incl. crash/affinity/dispatch/contract-alias, `credentials/`, `recovery/`, `tool-permission/`, `harness/smoke`).

## ANTI-PATTERNS

- Do NOT deep-import from `@openomni/*/src/*`; use package barrels only.
- Do NOT add empty catch blocks; coordinator needs explicit degradation behavior.
- Do NOT add generic catch-all files like `utils.ts` or `helpers.ts`.
- Do NOT put session-backed orchestration policy here; coordinator executes and recovers worker processes, while `@openomni/openomni` owns orchestration semantics.
- Do NOT build new features on `worker-pool/pool.ts` — it is a compatibility facade; target `worker-manager` directly.
