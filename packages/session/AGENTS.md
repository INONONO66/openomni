# packages/session

Session lifecycle, message/part storage, event bus, logs, telemetry, trace context, snapshots, artifacts, event log, surface-key routing, and worker-run records. Depends only on `@openomni/protocol`. In the workforce model, this package owns the durable substrate for original sessions, self-loop sessions, child Worker sessions, and worker-run history.

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── bus/                  # Bus pub/sub (Bus.publish / Bus.subscribe) + typed event descriptors
├── session/
│   ├── index.ts          # Session namespace barrel: public Session.* API re-exports
│   ├── events.ts         # Session bus event descriptors
│   ├── lifecycle.ts      # Session CRUD, child sessions, worker meta, TTL lazy deletion
│   ├── messages.ts       # Message/part writes, pagination, hydration, resume recovery
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + InMemoryStorage + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter facade (Bun SQLite persistence)
│   ├── sqlite-*-adapter.ts # SQLite sub-adapters by storage seam
│   ├── sqlite-schema-lifecycle.ts # PRAGMAs, migrations, and clear ordering
│   ├── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
│   ├── part-time.ts      # Message-part timestamp helpers
│   ├── wal-maintenance.ts # SQLite WAL checkpoint helpers
│   └── drizzle/          # Drizzle schema + migration artifacts
├── log/                  # Log namespace for observability records
├── telemetry/            # Telemetry helpers
├── trace/                # TraceContext helpers
├── snapshot/             # Snapshot.Provider + InMemorySnapshotProvider; Snapshot.Diff
├── artifact/             # Artifact.store / get / list / versions with write-through caching
├── app-connector/        # AppConnectorInstallationStore for durable installed-app lifecycle records
├── event-log/            # EventLog.append / replay / listIncomplete / markComplete (crash recovery)
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── work-item/            # WorkItemStore — universal work state engine
│   ├── index.ts          # WorkItemStore namespace barrel: public WorkItemStore.* API
│   ├── create.ts         # Work item creation, parent linkage, Created event
│   ├── crud.ts           # get/list/remove/update plus relation cleanup
│   ├── lifecycle.ts      # start/complete/fail/cancel, blockers, evidence, retry, outcome
│   ├── mutation.ts       # mutation persistence, transition validation, Updated/StatusChanged events
│   ├── dependency.ts     # dependency readiness + cycle detection
│   ├── builder.ts        # WorkItem.Info construction
│   └── types.ts          # Internal WorkItemStore implementation types
└── worker-run/           # WorkerRun — delegated execution records
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). Session implementation files import `../storage/storage`; `session/index.ts` is a namespace barrel and does not import storage directly. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.getWorkerMeta()` / `updateWorkerMeta()`, etc. No class instances.
- **Storage.Adapter**: Default is `InMemoryStorage`. `SqliteStorageAdapter` is the Bun SQLite persistent backend bootstrapped via `initialize({ dbPath })`. Its facade wires focused SQLite sub-adapter modules for required `session` / `message` / `part` and optional `artifact`, `surfaceKey`, `backgroundTask`, `cronJob`, `workItem`, `workerRunState`, and `appConnectorInstallation`. App connector installation records include Owner consent metadata plus disable/uninstall lifecycle operations because the installation record is the lifecycle SSOT. Schema lifecycle concerns that must evolve together (PRAGMAs, ordered migrations, clear ordering) live in `sqlite-schema-lifecycle.ts`. Unimplemented optional sub-objects gracefully degrade.
- **Migration 0006**: Legacy task/todo tables remain in SQLite for data preservation, but no TypeScript storage sub-adapters expose them.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation; WorkerRun events flow through `WorkerRun.Events.*`.
- **SurfaceKey routing**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs. In-memory forward/reverse indexes plus optional `Storage.Adapter.surfaceKey` for persistence.
- **Snapshot.Provider**: Interface for capturing and restoring session message state. `Snapshot.Diff` reports added / removed / modified message IDs.
- **WorkItemStore namespace**: `WorkItemStore.create()`, `.get()`, `.list()`, `.remove()`, `.update()`, `.start()`, `.complete(hash, completionReport)`, `.fail()`, `.cancel()`, `.addBlocker()`, `.resolveBlocker()`, `.addEvidence()`, `.addReadBackEvidence()`, `.areDependenciesMet()`, `.retry()`. Publishes `WorkItem.Events.*` (Created, Updated, StatusChanged, Completed, Failed, Removed) on every mutation. Gracefully degrades when `Storage.Adapter.workItem` is absent. Terminal state transitions are validated; completion requires a report whose claim evidence IDs resolve to ledger evidence. `parentHash` is create-only immutable.
- **WorkerRun**: Stored through the direct `workerRunState` adapter (`worker_run_state` table in SQLite). `WorkerRun.create()`, `WorkerRun.updateStatus()`, `WorkerRun.updateStatusIfCurrent()`, `WorkerRun.get()`, and `WorkerRun.listBySession()` publish lifecycle bus events but do not depend on event-log replay. State transitions such as `waiting_input → running` increment `resumeCount`.
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`; `Session.get()` and `.list()` check expiry and auto-delete.
- **Session lineage**: `Session.createChild()` + `parentSessionId` + `spawnDepth` are the current foundation for original → self-loop → child Worker trees. Future work should add explicit metadata conventions before adding new storage shapes.

## ANTI-PATTERNS

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing optional sub-adapters such as `backgroundTask`, `workItem`, and `workerRunState` from outside this package. For core session operations (session/message/part CRUD), prefer the namespace APIs (`Session.*`, `Artifact.*`, `EventLog.*`, `SurfaceKey.*`) for package-level invariants; note that bus publication is operation-specific. `Storage.getAdapter()` is an internal alias — both return the same adapter.
- Do NOT import internal paths from other packages — import from `@openomni/session` (index re-exports).
- Do NOT persist ad-hoc delegated execution state alongside `Session`; use `WorkerRun` so delegated execution state stays in the dedicated worker-run store.
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
