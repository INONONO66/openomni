# storage/

Task persistence layer for the openomni orchestration system.

## Files

- **task-storage.ts** — `TaskStore` interface (the contract), `InMemoryTaskStore` (default in-memory impl), and `TaskStorage` namespace (global adapter singleton). All consumer code goes through `TaskStorage.getAdapter()`.
- **file-task-storage.ts** — `FileTaskStore`, a file-backed `TaskStore` that mirrors in-memory state to JSON files on disk. Used by the CLI for durable task/run persistence.
- **task-types.ts** — Minimal `Task.Info`, `Task.Run`, `Task.Status` types needed by the storage layer. Owned by T2; do not modify here.
- **index.ts** — Barrel. Owned by T10; do not modify here.

## Architecture

`TaskStore` exposes two sub-objects: `task` (CRUD for `Task.Info`) and `run` (CRUD for `Task.Run` with idempotency and status indexing). `TaskStorage.configure(adapter)` sets the active adapter globally; defaults to `InMemoryTaskStore`.

`FileTaskStore` maintains the same in-memory Maps as `InMemoryTaskStore` plus flushes to disk on every mutation. Reads are always from memory; disk is the persistence backing store loaded at construction.

## Gotchas

- **Atomic writes**: `FileTaskStore` writes via tmp-file + rename to avoid partial writes on crash. The tmp cleanup in the catch block is intentional — if rename fails, the stale tmp must not linger.
- **No file locking**: Concurrent `FileTaskStore` instances on the same directory will corrupt state. Single-writer assumption.
- **Status index serialization**: `Set<string>` is stored as `string[]` in JSON; rebuilt from runs on parse failure.
- **Index consistency**: `run.set` maintains 4 secondary indices (taskRuns, idempotency, status, runs). All must stay in sync — partial updates corrupt lookups.
