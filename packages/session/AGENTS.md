# packages/session

Session lifecycle, message/part storage, event bus, logs, telemetry, trace context, snapshots, artifacts, event log, surface-key routing, and worker-run records. Depends only on `@openomni/protocol`. In the persona workforce model, this package owns the durable substrate for original sessions, self-loop sessions, child persona sessions, and worker-run history.

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
│   ├── wal-maintenance.ts # SQLite WAL checkpoint helpers
│   └── drizzle/          # Drizzle schema + migration artifacts
├── log/                  # Log namespace for observability records
├── telemetry/            # Telemetry helpers
├── trace/                # TraceContext helpers
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
- **Storage.Adapter**: Default is `InMemoryStorage`. `SqliteStorageAdapter` is the persistent backend bootstrapped via `initialize({ dbPath })`. Adapter sub-objects: required `session` / `message` / `part`; optional `artifact`, `eventLog`, `surfaceKey`, `backgroundTask`, `task`, `todo`. Unimplemented optional sub-objects gracefully degrade. The `task` and `todo` sub-adapters satisfy the interfaces defined in `@openomni/protocol`'s `Storage` namespace.
- **Migration 0006**: Adds `task`, `task_run`, `task_idempotency`, and `todo` tables to the SQLite schema, backing the `task` and `todo` optional sub-adapters in `SqliteStorageAdapter`.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation; subagent-related events (`Subagent.Events.*`) and `Todo.Updated` flow through the shared `Bus` too.
- **Todo namespace**: `Todo.update(sessionId, todos)` replaces the full todo list for a session and publishes `Todo.Updated`. `Todo.get(sessionId)` returns the current list. Both degrade gracefully when `Storage.Adapter.todo` is absent.
- **SurfaceKey routing**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs. In-memory forward/reverse indexes plus optional `Storage.Adapter.surfaceKey` for persistence.
- **Snapshot.Provider**: Interface for capturing and restoring session message state. `Snapshot.Diff` reports added / removed / modified message IDs.
- **WorkerRun**: Event-sourced via `Storage.Adapter.eventLog`. `WorkerRun.create()`, `WorkerRun.updateStatus()`, `WorkerRun.listBySession()`. State transitions (e.g. `waiting_input → running`) increment `resumeCount`. Used by `SubagentRuntime` / `BackgroundManager` to persist subagent runs.
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`; `Session.get()` and `.list()` check expiry and auto-delete.
- **Persona session lineage**: `Session.createChild()` + `parentSessionId` + `spawnDepth` are the current foundation for original → self-loop → child persona trees. Future work should add explicit metadata conventions before adding new storage shapes.

## ANTI-PATTERNS

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing optional sub-adapters (`task`, `todo`, `backgroundTask`) from outside this package. Use it directly when you need raw sub-adapter access. For core session operations (session/message/part CRUD), prefer the namespace APIs (`Session.*`, `Artifact.*`, `EventLog.*`, `SurfaceKey.*`) for package-level invariants; note that bus publication is operation-specific (for example, `Session.*` mutations and `Todo.update()`). `Storage.getAdapter()` is an internal alias — both return the same adapter.
- Do NOT import internal paths from other packages — import from `@openomni/session` (index re-exports).
- Do NOT persist ad-hoc subagent state alongside `Session`; use `WorkerRun` so it is event-sourced and replayable.
- Do NOT call `Storage.get().todo` directly for writes that require bus event publication — go through `Todo.update()` instead. For read-only queries that don't require event notification, direct access is OK (or use `Todo.get()`).
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
