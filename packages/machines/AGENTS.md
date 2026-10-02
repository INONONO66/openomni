# packages/machines

Refreshed 2026-10-02 (#1246, branch `epic1260/1246-packages-10-5`).

Machine execution package (`@openomni/machines`): a machine is WHERE execution happens, never WHO is delegated to. Owns the machine host/daemon lifecycle, confined fs/exec drivers, the per-tenant codemode facade (`src/codemode/`), and the Unix-socket NDJSON IPC transport (`src/ipc/`; the standalone ipc and codemode packages were absorbed here in #1246). The public surface is Effect-typed on Effect `4.0.0-rc.118`. Serializable message schemas stay in `@openomni/protocol` (`Ipc` and `Machine` namespaces); this package never validates run semantics or evaluates policy.

## STRUCTURE

```
src/
├── index.ts             # Barrel: host/daemon, typedCall, codemode, ipc transport, errors
├── host.ts              # createMachineHost — machine.attach server side
├── daemon.ts            # attachMachineDaemon — daemon client side, serves fs/exec/run_code
├── exec.ts / fs.ts      # Confined exec and filesystem drivers
├── errors.ts            # MachinesFailure (single untyped-Cause fallback) + machine error classes
├── failure.ts           # decodeMachineFailure / decodeIpcFailure / decodeCodeFailure — one MachinesFailure fallback
├── typed-call.ts        # Schema-derived typedCall facade for known Ipc.Methods (machine wire vocabulary lives here, beside its callers)
├── interrupt-on.ts      # onAbort
├── ipc/                 # Generic transport: framing, frame-schema, client, server, peer-request-table, callbacks, errors
└── codemode/            # Code facade: index (createCodemode), kernel (PythonKernel), errors
```

## DEPENDENCIES

`@openomni/protocol` (workspace, the only `@openomni` import — enforced by `script/check-deps.ts`), plus `effect@4.0.0-rc.118` (exact pin) and `zod`. Consumers: `apps/openomni` only.

## KEY PATTERNS (ipc transport)

- Bidirectional: both ends send requests, responses, and notifications over one socket. `classifyIpcMessage` in `ipc/peer-request-table.ts` is the only place the three wire schemas are tried; both client and server share `PeerRequestTable` for pending-call correlation, per-connection failure, and code-1000 answers when no request handler exists.
- Wire method names are frozen. `typedCall(caller, method, params, timeout?)` derives known method parameter/result types from protocol's `Ipc.Methods` without changing runtime validation; generic string `call()` remains for unknown peers. `typed-call.ts` lives outside `src/ipc/` so the generic transport carries no machine vocabulary.
- Error classes are the contract: `IpcTimeoutError`, `IpcConnectionError`, `IpcRemoteError` (wire code 1000 — a healthy connection whose far side refused), `IpcProtocolError` (wire codes 4000 schema-invalid / 4001 non-JSON), and `MachinesFailure` for non-IpcError thrown values (`decodeIpcFailure`; the former `IpcFailure`/`CodemodeFailure` duplicates were folded into `MachinesFailure` in #1246). Transport warnings and handler defects are Effect log events (`Effect.logWarning`/`Effect.logError`), never `console` calls.
- Handler failures never escape the socket listener; callback Effects are queued into the acquiring app scope by `makeDispatcher` (`ipc/callbacks.ts`) — socket event handlers never call an Effect runner.
- Failure classification is per connection: a dying connection rejects its in-flight calls as `IpcConnectionError` immediately; response ids are honored only on the connection their request was written to. A malformed line costs only itself (server answers 4001 and stays up; client drains valid frames then tears down); an oversize frame (>16 MiB) desyncs the decode buffer, so the server closes that connection after answering.
- Server writes are backpressure-safe through a per-connection queue flushed on `drain`. `createIpcServer` probes an existing socket file and only unlinks it when provably dead; `notify()` yields `false` when no client is connected; `onDisconnect(connectionId)` fires exactly once per torn-down connection after its in-flight requests were failed.

## KEY PATTERNS (codemode)

- `createCodemode` consumes only the structural machines port (`Pick<MachineHost, "list" | "get">`) and protocol; it owns machine object handles and per-tenant interpreters. The composition root injects the returned runner into a machine daemon; the facade never spawns Python outside `codemode/kernel.ts`.
- Typed refusals are `CodemodeError` (`closed`, `machines_not_bound`, `machine_not_found`, `ambiguous_machine`, `unknown_cell_id`); driver boundary faults are `DriverFailure`; everything untyped decodes to `MachinesFailure` via `decodeCodeFailure`.
- Injected entropy (#1245): cell ids come from the injected `id` source; no ambient crypto fallback.

## TESTS

`test/` (host/daemon/fs/exec lifecycle), `test/ipc/` (framing split-multibyte and oversized frames, frame-schema, failure classes, backpressure, resilience, bidirectional, peer-request-table, callbacks, client/server edges, disconnect, socket-path, native client, typed facade + `typed-facade-fixtures/compile-red.ts`), `test/codemode/` (consumer, kernel, bridge). Effect execution goes only through the package runner owners (`test/helpers/effect.ts`, `test/ipc/helpers/effects.ts` — `script/check-effect-boundaries.ts` `RUNNER_OWNERS`).

## ANTI-PATTERNS

- Do NOT add kernel/ledger/policy or product-app imports — the dependency ratchet fails; `@openomni/protocol` stays the only workspace import.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import from `@openomni/machines/src/*`; use the package barrel.
- Do NOT reintroduce machine vocabulary (protocol `Machine.*`, `Ipc.Methods`) inside `src/ipc/` — the transport stays generic; `typed-call.ts` and its callers own the wire-method table.
- Do NOT add per-domain untyped-fallback error classes; `MachinesFailure` is the single fallback (`src/failure.ts`).
- Do NOT call `Effect.run*` in package tests outside the runner-owner helpers, and never in `src/` — the boundary checker owns both rules.
