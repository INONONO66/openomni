# packages/session

Session lifecycle, message/part storage, event bus, snapshots, artifacts, event log, surface-key routing, and worker-run records. Depends only on `@openomni/protocol`.

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── bus/                  # Bus pub/sub (Bus.publish / Bus.subscribe) + typed event descriptors
├── session/
│   ├── index.ts          # Session namespace: CRUD, messages/parts, child sessions, worker meta
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + InMemoryStorage + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter (Drizzle-backed persistence)
│   ├── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
│   ├── part-time.ts      # Message-part timestamp helpers
│   └── drizzle/          # Drizzle schema + migration artifacts
├── snapshot/             # Snapshot.Provider + InMemorySnapshotProvider; Snapshot.Diff
├── artifact/             # Artifact.store / get / list / versions with write-through caching
├── event-log/            # EventLog.append / replay / listIncomplete / markComplete (crash recovery)
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── todo/                 # Todo.update(sessionId, todos) / Todo.get(sessionId) — publishes Todo.Updated bus event
└── worker-run/           # WorkerRun — event-sourced subagent execution records
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). `session/index.ts` imports `./info` and `../storage/storage`. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.getWorkerMeta()` / `updateWorkerMeta()`, etc. No class instances.
- **Storage.Adapter**: Default is `InMemoryStorage`. `SqliteStorageAdapter` is the persistent backend bootstrapped via `initialize({ dbPath })`. Adapter sub-objects: required `session` / `message` / `part`; optional `artifact`, `eventLog`, `surfaceKey`, `backgroundTask`, `task`, `plan`, `todo`. Unimplemented optional sub-objects gracefully degrade. The `task`, `plan`, and `todo` sub-adapters satisfy the interfaces defined in `@openomni/protocol`'s `Storage` namespace.
- **Migration 0006**: Adds `task`, `task_run`, `task_idempotency`, `plan`, and `todo` tables to the SQLite schema, backing the `task`, `plan`, and `todo` optional sub-adapters in `SqliteStorageAdapter`.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation; subagent-related events (`Subagent.Events.*`) and `Todo.Updated` flow through the shared `Bus` too.
- **Todo namespace**: `Todo.update(sessionId, todos)` replaces the full todo list for a session and publishes `Todo.Updated`. `Todo.get(sessionId)` returns the current list. Both degrade gracefully when `Storage.Adapter.todo` is absent.
- **SurfaceKey routing**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs. In-memory forward/reverse indexes plus optional `Storage.Adapter.surfaceKey` for persistence.
- **Snapshot.Provider**: Interface for capturing and restoring session message state. `Snapshot.Diff` reports added / removed / modified message IDs.
- **WorkerRun**: Event-sourced via `Storage.Adapter.eventLog`. `WorkerRun.create()`, `WorkerRun.updateStatus()`, `WorkerRun.listBySession()`. State transitions (e.g. `waiting_input → running`) increment `resumeCount`. Used by `SubagentRuntime` / `BackgroundManager` to persist subagent runs.
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`; `Session.get()` and `.list()` check expiry and auto-delete.

## ANTI-PATTERNS

- Do NOT access `Storage.getAdapter()` directly from outside this package — go through the `Session.*` / `WorkerRun.*` / `Artifact.*` / `EventLog.*` / `SurfaceKey.*` namespaces.
- Do NOT import internal paths from other packages — import from `@openomni/session` (index re-exports).
- Do NOT persist ad-hoc subagent state alongside `Session`; use `WorkerRun` so it is event-sourced and replayable.
- Do NOT call `Storage.get().todo` directly from outside this package — go through `Todo.update()` / `Todo.get()` so the bus event is always published.
