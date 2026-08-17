# packages/ipc

Standalone worker-process IPC transport (`@openomni/ipc`, extracted from `packages/coordinator` in #496). Pure transport over Unix sockets: NDJSON framing with a 16 MiB frame cap, bidirectional request/response/notification client + server, and typed transport errors. Serializable message schemas stay in `@openomni/protocol` (`Ipc` namespace); this package never validates run semantics or evaluates policy.

## STRUCTURE

```
src/
├── index.ts      # Package barrel — the published contract surface
├── framing.ts    # encode() + LineDecoder (NDJSON, 16 MiB cap, streaming TextDecoder state)
├── client.ts     # connectIpcClient — outbound connection; onRequest/onNotification make it bidirectional
├── server.ts     # createIpcServer — Bun.listen Unix socket server, per-connection decoders, call/notify
└── errors.ts     # IpcConnectionError / IpcTimeoutError / IpcProtocolError / IpcRemoteError
```

## DEPENDENCIES

Depends on `@openomni/protocol` **only** — enforced by `script/check-deps.ts`. This package is driver-band consumable as a published contract: driver-band packages (`channels`, `remote`, `browser`, `machines`, and successors, possibly from separate repositories) may depend on it, and it must never grow a kernel/ledger/policy/session import. Widening its dependency set requires Owner sign-off.

## CONTRACT

- Bidirectional: both ends can send requests, responses, and notifications over one socket — server → owner-device reverse connections ride the same pair.
- Wire method names are frozen (Greg Young rule); the transport passes method/params through opaquely.
- Authentication is the caller's job (workers check `authToken` in handlers); the transport carries but never inspects credentials.
- Timeout (`IpcTimeoutError`), connection (`IpcConnectionError`), remote-handler failure (`IpcRemoteError`, wire error code 1000 — a HEALTHY connection whose far side refused; both call directions file it identically, and a handlerless client answers with it rather than silently dropping), and malformed-frame (`IpcProtocolError`, wire error codes 4000/4001) behavior is part of the contract.
- Handler failures never escape the socket listener: BOTH sync throws and async rejections of a request handler become the code-1000 error frame (notification-handler failures are logged; the spec gives notifications no error responses).
- 4000/4001 correlation is best-effort, not guaranteed: a schema-invalid frame (4000) that still parsed as JSON with a string `id` gets that id echoed so the requester's pending settles; a non-JSON line (4001) has no recoverable id and is answered under `id: "unknown"`, which no pending will match — those callers fall back to their timeout or the connection close.
- Failure classification is per connection: a dying connection rejects ITS in-flight server calls as `IpcConnectionError` immediately, even while other connections survive — never left to age out as a timeout. Response matching is scoped the same way: a response id is only honored on the connection its request was written to.
- A malformed (non-JSON) frame costs only itself: every parseable frame in the same chunk still delivers immediately, in order. The server answers each malformed line with its own 4001 error frame and keeps the connection alive; the client stays conservative and tears the connection down — but only after draining the chunk's valid frames. An OVERSIZE frame (>16 MiB) is different by design: it is a DoS guard that resets the connection's entire decode buffer mid-frame, so after answering 4001 the server CLOSES the desynced connection (the client tears down on the FIN, failing its pendings as `IpcConnectionError` instead of burning timeouts).
- Server writes are backpressure-safe: Bun sockets do not buffer partial writes, so every server write goes through a per-connection queue flushed on `drain`; frames arrive intact and in order regardless of frame size or reader speed. Requests whose bytes die queued fail as `IpcConnectionError` with their connection.
- `createIpcServer` is async and never steals a live server's socket: an existing socket file is probed first and only unlinked when provably dead (`IpcConnectionError` otherwise). `notify()` returns `false` when it dropped the notification because no client is connected.

## CONSUMERS

`packages/coordinator` (worker supervision client side), `apps/server/src/execution/worker-entry.ts` (worker-side server), test harnesses (`packages/openomni/test/harness/policy-echo-worker.ts`, coordinator fixtures), and the manual QA driver `apps/server/src/manual/ipc-worker-driver.ts`.

## TESTS

`test/framing.test.ts` (frame cap, UTF-8 streaming state, malformed-line skip-and-report), `test/failure-classes.test.ts` (per-connection failure classes, malformed-frame isolation over a real socket, oversize desync close, error-id correlation, cross-connection response scoping), `test/backpressure.test.ts` (multi-megabyte frames survive a slow reader byte-exact and in order), `test/transport-resilience.test.ts` (sync/async handler failure containment, schema-mismatch surfacing, live-socket probe, notify drop signal), `test/ipc-bidirectional.test.ts` (both directions over a real socket), `test/ipc-extraction.test.ts` (#496 extraction contract: round trips, auth rejection, malformed frames, timeout/protocol errors, secret non-leakage, worker-entry startup smoke).

## ANTI-PATTERNS

- Do NOT add `@openomni/session`/`@openomni/openomni`/`@openomni/policy` imports — the dep ratchet will fail.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import from `@openomni/ipc/src/*`; use the package barrel.
