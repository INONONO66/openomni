# manualQa — lane C2 (close patch-coverage gaps), worktree openomni-w53 @ 10c26e80

Goal: every changed executable line vs origin/main in this lane's ownership (reason.ts:29, gateway-transport.ts:120-124, 151-153, 187-189, 215-216) covered by a real, failure-capable test; verified the CI way. No ulw-loop plan exists (currentAttemptDir undefined), so artifacts live in the caller's evidence directory `.omo/reports/kernel-campaign-w53/evidence/C2/`.

All commands ran with `/opt/homebrew/bin` stripped from PATH and bun via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`, per brief.

## surfaceEvidence

| scenario id | criterion | surface | exact invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| SE-1 | brief: baseline — the 13 lines are uncovered before any change | CLI (coverage checker over real LCOV) | `cd apps/desktop && bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage` then `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` | PASS (exit 1, all 13 brief lines listed) | A1, A2 |
| SE-2 | brief: cover gateway-transport.ts:120-124 (pagination follow-up cursor) | CLI (bun test over a real Bun.serve WebSocket wire) | `cd apps/desktop && bun test gateway-transport session-time --timeout 15000` — test "a page pointing at a next revision is followed with a cursor until the read drains" | PASS (in final run: 437 pass / 0 fail) | A3 |
| SE-3 | brief: cover gateway-transport.ts:151-153 (session error frame rejects read) | CLI (bun test, real WebSocket wire) | same run — test "a session-scoped error frame rejects that session's pending read" | PASS | A3 |
| SE-4 | brief: cover gateway-transport.ts:187-189 (drain rejects pending reads on close) | CLI (bun test, real WebSocket wire; close via `server.stop(true)`, no sleeps — awaits the server-received-frame event then the rejection) | same run — test "a socket that closes mid-read rejects the pending read" | PASS | A3 |
| SE-5 | brief: cover gateway-transport.ts:215-216 (readSession send catch) | CLI (bun test, injected SocketLike whose `send` throws on session_read) | same run — test "a send failure during a session read rejects instead of hanging" | PASS | A3 |
| SE-6 | brief: cover reason.ts:29 (null phase -> "not connected") | CLI (bun test, direct module import) | same run — test "a session with no durable page yet reads as not connected" | PASS | A3 |
| SE-7 | brief: verify the CI way — full desktop coverage run + patch-coverage checker, no owned lines remain | CLI | `cd apps/desktop && bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage` (exit 0, 437/0) then `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` (exit 1; `grep -cE 'uncovered: apps/desktop/src/renderer/(attention/reason|chat/gateway-transport)'` = 0; remaining 64 entries are other lanes' `no coverage record` files) | PASS | A3, A4 |
| SE-8 | brief: `bunx ultracite check --formatter-enabled=false <changed files>` clean | CLI | `bunx ultracite check --formatter-enabled=false apps/desktop/test/gateway-transport.test.ts apps/desktop/test/session-time.test.tsx` -> exit 0 | PASS | A5 |
| SE-9 | brief: tsc for the touched workspace | CLI | `cd apps/desktop && bunx tsc --noEmit` -> exit 0 | PASS | A6 |
| SE-10 | brief: `bun run script/check-written-types.ts` must stay 0 | CLI | `bun run script/check-written-types.ts` -> exit 0, "written any/unknown types: 0" | PASS | A7 |

## adversarialCases

| scenario id | criterion | adversarial class | expected behavior | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| AC-1 | SE-2 | coverage-without-assertion (test that executes but cannot fail) | mutate source: follow-up cursor `revision: frame.nextRevision + 1`; test must fail | PASS (bun test exit 1, `expect(cursors).toEqual` mismatch; source restored via git checkout) | A8 |
| AC-2 | SE-4 | coverage-without-assertion | mutate source: `drain(next)` drops "gateway socket closed unexpectedly"; test must fail on exact message | PASS (exit 1, Expected "gateway socket closed unexpectedly" / Received "gateway socket closed") | A9 |
| AC-3 | SE-3 | coverage-without-assertion | mutate source: drop `frame.reason` from the rejection message chain; test must fail | PASS (exit 1) | A10 |
| AC-4 | SE-5 | coverage-without-assertion | mutate source: catch rejects a substitute error instead of the thrown one; test must fail | PASS (exit 1) | A11 |
| AC-5 | SE-6 | coverage-without-assertion | mutate source: return "offline" instead of "not connected"; test must fail | PASS (exit 1) | A12 |
| AC-6 | SE-2..SE-6 | timing-dependent test / hidden sleeps | new tests contain no sleeps or polling; every wait is an awaited event (server-received frame, stream rejection, subscribed page) — verified by reading the added test code and by deterministic sub-10ms test durations across runs | PASS | A3 |
| AC-7 | brief rule: owned files only | out-of-scope writes | `git diff --stat apps/desktop/test/` shows only the 2 owned test files (+145); `git diff --quiet -- apps/desktop/src/renderer` clean after mutant restoration. AGENTS.md/docs/* modifications in `git status` predate/parallel this lane (concurrent lanes share the worktree) and contain only campaign doc stamps, none of this lane's content | PASS | A13 |
| AC-8 | brief rule: dead-code deletion instead of test-faking | dead-code misclassification | not_applicable — all 13 lines proved reachable: each is executed by a real wire scenario and its mutant fails, so none is dead code to delete | not_applicable | A3, A8-A12 |

## artifactRefs

| id | kind | description | path (relative to /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/evidence/C2/) |
| --- | --- | --- | --- |
| A1 | test log | baseline desktop coverage run before changes (432 pass / 0 fail, exit 0) | baseline-desktop-tests.txt |
| A2 | checker log | baseline patch-coverage checker output listing exactly the 13 brief lines as uncovered (exit 1) | baseline-checker.txt |
| A3 | test log | final desktop coverage run with the 5 new tests (437 pass / 0 fail, exit 0) | final-desktop-tests.txt |
| A4 | checker log | final patch-coverage checker: 0 uncovered lines under apps/desktop/src/renderer/{attention/reason,chat/gateway-transport}; 64 remaining entries all other-lane `no coverage record` | final-checker.txt |
| A5 | lint log | ultracite check on the 2 changed files, exit 0 | ultracite.txt |
| A6 | typecheck log | `tsc --noEmit` for apps/desktop, exit 0 (empty output) | tsc.txt |
| A7 | gate log | check-written-types: "OK: written any/unknown types: 0", exit 0 | check-written-types.txt |
| A8 | mutation log | pagination cursor mutant killed (exit 1) | mutant-pagination.txt |
| A9 | mutation log | drain-message mutant killed (exit 1) | mutant-drain-message.txt |
| A10 | mutation log | error-reason-fallback mutant killed (exit 1) | mutant-error-reason.txt |
| A11 | mutation log | send-catch substitute-error mutant killed (exit 1) | mutant-send-catch.txt |
| A12 | mutation log | reason-string mutant killed (exit 1) | mutant-reason.txt |
| A13 | receipt | lane receipt with full diff stat, commands, exit codes | ../../C2.md |

Verdict: all owned lines covered by failure-capable tests; all gates green; nothing committed.

## Anomaly note (post-run)

This lane ran no `git commit` (all git invocations in-session were status/diff/log/checkout-restore). At 12:26:16 a concurrent actor in this shared worktree created commit `e91c8556` ("W5.3 #1113: C2 desktop patch coverage ...") that includes this lane's two test files plus C2.md/C2-brief.md/B-verify.md. The "Do NOT commit" rule was observed by this lane; the commit is external.
