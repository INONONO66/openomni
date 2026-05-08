# storage/

Thin re-export shim. Task types (`Task.Info`, `Task.Run`, `Task.Status`, etc.) now live in `@openomni/protocol/task` and are re-exported here for backward compatibility.

## Files

- **task-types.ts** — `export { Task } from "@openomni/protocol"`. No logic.

## Where persistence actually lives

Task and todo persistence lives in `@openomni/session`. The `Storage.Adapter` in that package has two optional sub-adapters:

- `task` — satisfies `Storage.TaskSubAdapter` from `@openomni/protocol`
- `todo` — satisfies `Storage.TodoSubAdapter` from `@openomni/protocol`

`SqliteStorageAdapter` in `@openomni/session` implements both, backed by migration 0006 tables (`task`, `task_run`, `task_idempotency`, `todo`).

## Gotchas

- `TaskStorage` and `SqliteTaskStore` no longer exist. Any code that called `TaskStorage.configure()` must be updated to configure `Storage.Adapter` in `@openomni/session` instead.
- Tool providers (`TaskToolProvider`, `TodoToolProvider`) read from `Storage.get()` in `@openomni/session` directly.
