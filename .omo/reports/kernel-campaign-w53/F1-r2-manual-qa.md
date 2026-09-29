# manualQa — F1-r2 (frozen receipt + additive session_bound)

No ulw-loop plan exists (`agentToolkit.status().currentAttemptDir` = none), so
artifacts live in the caller's evidence directory:
`.omo/reports/kernel-campaign-w53/F1-r2-artifacts/`.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| S1 receipt is frozen at its base shape | brief: "restore the existing accepted receipt to EXACTLY its base shape" | real Bun WebSocket, full app (residentSuite boot, `session-cursor.test.ts`) | `mise exec bun@1.4.1 -- bun test --config=/dev/null --timeout 15000 apps/openomni/test/session-cursor.test.ts ...` — `expect(await accepted).toEqual({type:"receipt",status:"accepted"})` over the live socket | PASS (exit 0, 49 pass) | A1 |
| S2 two-frame sequence receipt→session_bound on one socket | brief: "Frame ordering: receipt first, then session_bound, on the same socket" | real app WebSocket (same run) + production `WebSocketHandler.handleFrame` via channels callbacks | session-cursor order recorder asserts `["receipt","session_bound"]`; channels test asserts `sent` = [two-key receipt, session_bound] in order | PASS (exit 0) | A1 |
| S3 channels handleFrame emits receipt with exactly two keys then session_bound | brief test requirement | production `WebSocketHandler` through `websocketCallbacks` (the same send path the app uses) | `bun test packages/channels/test/websocket.test.ts` — `Object.keys(...)` equals `["type","status"]`, second frame `{type:"session_bound",result}` | PASS (exit 0) | A1 |
| S4 desktop binds from session_bound | brief: "desktop bindSession consumes session_bound instead of receipt.result" | desktop transport over a real Bun ws server (`session-read-model.test.ts` durable-binding flow) and injected socket (`gateway-transport.test.ts`) | `bun test apps/desktop/test/session-read-model.test.ts apps/desktop/test/gateway-transport.test.ts` — `onSessionBound` fires with the durable target only after `session_bound` | PASS (exit 0) | A1 |
| S5 `result` deleted from SessionRead.Receipt | brief DTO requirement | protocol source + repo grep | `rg 'receipt\.result\b'` → exit 1 (0 matches); `Receipt` schema is two strict literals; protocol workspace tsc + 502 tests pass | PASS | A2, A4 |
| S6 quality gates on changed files | brief rules | CLI gates | ultracite 0; tsc 0 in protocol/channels/desktop/openomni; check-effect-boundaries 0; check-written-types 0; patch coverage "all changed executable lines are covered" exit 0 | PASS | A3, A4, A5 |

## adversarialCases

| scenario | criterion | class | expected | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| X1 legacy result-bearing receipt replayed to desktop | frozen-frame STOP | stale/legacy frame injection | strict `Receipt` refuses the frame; it is dropped and never binds | PASS — `gateway-transport.test.ts` "binds only from session_bound…" injects the retired receipt, `bound` stays `[]` | A1 |
| X2 blocked_pre admission in session_bound | binding correctness | boundary value of the result union | no binding (no durable handle) | PASS — same test injects `{status:"blocked_pre",reasonCode:"policy"}`, no bind; only the executed result binds | A1 |
| X3 void handler result (channel message with no admission forwarding) | base-behavior preservation | absent optional data | single two-key receipt, no session_bound | PASS — channels "defers ingress … exactly once" still asserts the lone receipt | A1 |
| X4 tests pass by construction (cannot fail) | test discipline | mutant | deleting the receipt-first send must fail the new test | PASS — scratch mutant run exit 1 (1 fail), reverted, suite green | A6 |
| X5 malformed/malicious ws frames | ingress hardening | fuzz frames (`{`, `[]`, `{}`, forged request_answer) | rejected before the handler with typed reasons | PASS — pre-existing channels rejection matrix still green in the same run | A1 |
| X6 receipt gains a field again (regression of the STOP itself) | frozen frame | additive-field regression | exact-keys assertions in channels + session-cursor fail on any third key | PASS — assertions are `toEqual`/`Object.keys` exact | A1 |
| X7 concurrent overlapping reads | review finding 4 | not_applicable — owned by lane F4-r2 (its coalescing edits are concurrently present in the same file and its tests passed in run A1); this lane did not alter read-waiter behavior | — | not_applicable | — |

## artifactRefs

| id | kind | description | path |
| --- | --- | --- | --- |
| A1 | test log | focused suite: channels ws, desktop transport, desktop read model, openomni session-cursor — 49 pass / 0 fail, exit 0 | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/focused-tests.log` |
| A2 | coverage/test log | packages/protocol full suite with lcov (502 pass) | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/cov-protocol.log` |
| A3 | coverage/test log | packages/channels (578 pass) and apps/desktop (441+15 pass) full suites with lcov | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/cov-channels.log`, `.../cov-desktop.log` |
| A4 | coverage/test log | apps/openomni full suite with lcov (557 pass; nested expected-failure subprocess inside passing 967-U1 meta-test) | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/cov-openomni.log` |
| A5 | gate log | patch coverage gate: "all changed executable lines are covered", exit 0 | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/patch-cov.log` |
| A6 | mutant log | scratch mutant (receipt send deleted): 1 fail, exit 1; reverted | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/f1r2-mutant.log` |
| A7 | gate log | `check-written-types`: `OK: written any/unknown types: 0` | `.omo/reports/kernel-campaign-w53/F1-r2-artifacts/f1r2-types.log` |
