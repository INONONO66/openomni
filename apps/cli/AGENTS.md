# apps/cli

Local CLI for OpenOmni. Today it only covers **credential management** (`auth`) and **adapter configuration** (`config`). Channel adapters, the conversation runtime, and HTTP / WebSocket surfaces live in [`apps/server`](../../apps/server) — not here.

## STRUCTURE

```
src/
├── index.ts          # Entry — initializes ModelsDev, Storage (SQLite), TaskStorage (FileTaskStore), and registers yargs commands
├── cmd/
│   ├── auth.ts       # `openomni auth login | logout | list`
│   └── config.ts     # `openomni config add | list | remove` (adapter config entries)
├── adapter/
│   └── types.ts      # Adapter config type — shared by the `config` command
└── config/
    └── index.ts      # Persisted adapter config helpers
```

No `serve` command, no channel adapters, no per-adapter implementation files — those responsibilities moved to `apps/server`.

## BOOT SEQUENCE (`src/index.ts`)

1. `ModelsDev.init()` — prime the model catalog fetcher.
2. `Storage.initialize({ dbPath: ~/.openomni/storage.db })` — bootstrap the SQLite storage adapter used by `@openomni/session`.
3. `TaskStorage.configure(new FileTaskStore(~/.openomni/tasks))` — file-backed task persistence for `@openomni/openomni`.
4. Register the `auth` and `config` yargs commands; `demandCommand(1)` is enforced.

## HOW TO ADD

### A new command

1. Create `src/cmd/{name}.ts` exporting a yargs `CommandModule`.
2. Register it in `src/index.ts` alongside `AuthCommand` / `ConfigCommand`.
3. If the command needs storage / task state, rely on the bootstrap initialization — do not re-initialize.

### A new channel / adapter

Do it in [`apps/server`](../../apps/server), not here. The CLI only stores adapter configuration values that the server reads at boot.

## ANTI-PATTERNS

- **Deep imports**: `cmd/auth.ts` imports `@openomni/llm/src/auth/registry` and `@openomni/llm/src/auth/storage` directly instead of the package barrel. This is tracked tech debt — do NOT extend. New code must import from `@openomni/llm`.
- **Channel code in CLI**: If you are reaching for Discord / Telegram / GitHub / WebSocket code, stop and use `apps/server` instead.
- **Per-command ad-hoc storage setup**: Initialization happens exactly once in `src/index.ts`. Don't call `Storage.initialize` or `TaskStorage.configure` from inside a command.

## KNOWN TECH DEBT

- Zero test coverage in this app.
- Two deep imports into `@openomni/llm` internals in `cmd/auth.ts` (see above).
