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
- Timeout (`IpcTimeoutError`), connection (`IpcConnectionError`), remote-handler failure (`IpcRemoteError`, wire error code 1000 — a HEALTHY connection whose far side refused; both call directions file it identically), and malformed-frame (`IpcProtocolError`, wire error codes 4000/4001) behavior is part of the contract.

## CONSUMERS

`packages/coordinator` (worker supervision client side), `apps/server/src/execution/worker-entry.ts` (worker-side server), test harnesses (`packages/openomni/test/harness/policy-echo-worker.ts`, coordinator fixtures), and the manual QA driver `apps/server/src/manual/ipc-worker-driver.ts`.

## TESTS

`test/framing.test.ts` (frame cap, UTF-8 streaming state), `test/ipc-bidirectional.test.ts` (both directions over a real socket), `test/ipc-extraction.test.ts` (#496 extraction contract: round trips, auth rejection, malformed frames, timeout/protocol errors, secret non-leakage, worker-entry startup smoke).

## ANTI-PATTERNS

- Do NOT add `@openomni/session`/`@openomni/openomni`/`@openomni/policy` imports — the dep ratchet will fail.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import from `@openomni/ipc/src/*`; use the package barrel.
