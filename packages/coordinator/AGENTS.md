# packages/coordinator

Multiprocess coordinator daemon + test harness. This package will eventually house the coordinator daemon process, worker pool management, and IPC transport layer. Currently contains only the test harness infrastructure needed for Phase 4 multiprocess worker testing.

## STRUCTURE

```
src/
└── index.ts              # Package barrel (empty until Phase 1 implementation)

test/
└── harness/
    ├── spawn.ts          # Child Bun process spawn + lifecycle management
    ├── ipc.ts            # Unix socket connection helpers (JSON-newline framing)
    ├── fixtures.ts       # Fake coordinator/worker stubs for testing
    ├── assertions.ts     # Multiprocess-specific test assertions
    └── smoke.test.ts     # Basic smoke test for the harness itself
```

## DEPENDENCIES

No internal `@openomni/*` dependencies. Depends only on Bun built-ins and TypeScript.

## PURPOSE OF EACH HARNESS MODULE

| Module | Purpose |
|--------|---------|
| `spawn.ts` | Wraps `Bun.spawn()` with lifecycle tracking — spawn, pipe stdout/stderr, SIGTERM on cleanup |
| `ipc.ts` | Unix domain socket client helpers with JSON-newline framing and connect timeout |
| `fixtures.ts` | Minimal UDS echo server (fake coordinator) and heartbeat client (fake worker) for isolated tests |
| `assertions.ts` | `assertNoOrphanProcesses` + `assertCleanExit` for verifying process lifecycle invariants |
| `smoke.test.ts` | Proves the harness can spawn a child process and observe clean exit |

## FUTURE (Phase 1+)

- `src/daemon/` — coordinator daemon entry point
- `src/worker/` — worker process entry point
- `src/ipc/` — production IPC transport (Unix domain socket, JSON-RPC)
- `src/pool/` — worker pool lifecycle management

## ANTI-PATTERNS

- Do NOT import from other `@openomni/*` packages until Phase 1 implementation begins.
- Do NOT add runtime dependencies (no npm packages beyond typescript devDep).
- Harness modules in `test/harness/` are test utilities only — not for production use.
