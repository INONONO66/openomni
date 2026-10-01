# packages/ipc

Refreshed 2026-09-29 (W5.3 #1113, branch `kernel/1113-w5-closure-20260929`).

Standalone IPC transport (`@openomni/ipc`, extracted in #496). Unix-socket NDJSON transport whose public surface is Effect-typed on Effect `4.0.0-rc.118`: `connectIpcClient` returns `Effect.Effect<IpcClient, IpcError, Scope.Scope>`, `createIpcServer` returns an Effect-scoped server, and every call/close/notify is an Effect. Serializable message schemas stay in `@openomni/protocol` (`Ipc` namespace); this package never validates run semantics or evaluates policy. Tests run Effects only through the package's single runner owner, `test/helpers/effects.ts` (`script/check-effect-boundaries.ts` `RUNNER_OWNERS`).

## STRUCTURE

```
src/
├── index.ts             # Barrel: connectIpcClient, createIpcServer, typedCall, errors
├── framing.ts           # encode() + LineDecoder (NDJSON, 16 MiB frame cap, streaming TextDecoder)
├── frame-schema.ts      # FrameSchema — PlainValue guard rejecting -0 and unsafe numbers
├── client.ts            # connectIpcClient — scoped outbound connection; onRequest/onNotification make it bidirectional
├── server.ts            # createIpcServer — Bun.listen Unix server, live-socket probe, drain-safe write queues
├── peer-request-table.ts# classifyIpcMessage (the one wire classifier) + shared pending-request table
├── callbacks.ts         # makeDispatcher — app-scope-owned callback queue; socket callbacks never run a runtime
├── failure.ts           # decodeIpcFailure — thrown values → typed IpcError union (IpcFailure fallback)
├── typed-call.ts        # Schema-derived typedCall facade for known Ipc.Methods
└── errors.ts            # IpcFailure / IpcConnectionError / IpcTimeoutError / IpcProtocolError / IpcRemoteError
```

## DEPENDENCIES

`@openomni/protocol` (workspace, the only `@openomni` import — enforced by `script/check-deps.ts`), plus `effect@4.0.0-rc.118` (exact pin) and `zod`. Driver-band consumable: `channels`, `machines`, and successors may depend on it; it must never grow a kernel/ledger/policy import.

## CONTRACT

- Bidirectional: both ends send requests, responses, and notifications over one socket. `classifyIpcMessage` in `peer-request-table.ts` is the only place the three wire schemas are tried; both client and server share `PeerRequestTable` for pending-call correlation, per-connection failure, and code-1000 answers when no request handler exists.
- Wire method names are frozen. `typedCall(caller, method, params, timeout?)` derives known method parameter/result types from protocol's `Ipc.Methods` without changing runtime validation; generic string `call()` remains for unknown peers.
- Error classes are the contract: `IpcTimeoutError`, `IpcConnectionError`, `IpcRemoteError` (wire code 1000 — a healthy connection whose far side refused), `IpcProtocolError` (wire codes 4000 schema-invalid / 4001 non-JSON), and `IpcFailure` for non-IpcError thrown values (`decodeIpcFailure`). Transport warnings and handler defects are Effect log events (`Effect.logWarning`/`Effect.logError`), never `console` calls.
- Handler failures never escape the socket listener; callback Effects are queued into the acquiring app scope by `makeDispatcher` — socket event handlers never call an Effect runner.
- Failure classification is per connection: a dying connection rejects its in-flight calls as `IpcConnectionError` immediately; response ids are honored only on the connection their request was written to. A malformed line costs only itself (server answers 4001 and stays up; client drains valid frames then tears down); an oversize frame (>16 MiB) desyncs the decode buffer, so the server closes that connection after answering.
- Server writes are backpressure-safe through a per-connection queue flushed on `drain`. `createIpcServer` probes an existing socket file and only unlinks it when provably dead; `notify()` yields `false` when no client is connected; `onDisconnect(connectionId)` fires exactly once per torn-down connection after its in-flight requests were failed.

## CONSUMERS

`packages/machines` (daemon client + host server for `machine.attach`) and `apps/openomni/src/delegation/` (process transport).

## TESTS

`test/framing.test.ts`, `frame-schema.test.ts`, `failure-classes.test.ts`, `backpressure.test.ts`, `transport-resilience.test.ts`, `transport-framing.test.ts`, `ipc-bidirectional.test.ts`, `peer-request-table.test.ts`, `callback-contract.test.ts`, `client-edges.test.ts` / `server-edges.test.ts`, `disconnect.test.ts`, `socket-path.test.ts`, `native-client.test.ts`, `typed-facade-types.test.ts` (+ `typed-facade-fixtures/compile-red.ts`). All Effect execution goes through `test/helpers/effects.ts`.

## ANTI-PATTERNS

- Do NOT add ledger, policy, or product-app imports — the dependency ratchet fails.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import from `@openomni/ipc/src/*`; use the package barrel.
- Do NOT call `Effect.run*` in package tests outside `test/helpers/effects.ts`, and never in `src/` — the boundary checker owns both rules.
