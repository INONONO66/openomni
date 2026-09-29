# manualQa — lane F4-r2 (review-r2 finding 4)

No ulw-loop plan exists (`agentToolkit.status()` returned no
`currentAttemptDir`), so artifacts live in the caller's evidence directory:
`.omo/reports/kernel-campaign-w53/F4-r2-artifacts/`.

All Bun invocations: `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`, cwd
`/Users/ino/Develop/openomni-w53`, `/opt/homebrew/bin` stripped from PATH,
`D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python`.
The behavior under test is a WebSocket client transport; the faithful surface
is a real Bun WebSocket server driven by the exported `readSession` API inside
`bun test` (event-driven, no sleeps).

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| F4-S1 coalesced identical reads | brief: "two concurrent identical reads both resolve from one page" | real Bun WS server + exported `readSession` | `bun test --config=/dev/null --timeout 15000 apps/desktop/test/gateway-transport.test.ts` — test `two concurrent identical reads coalesce onto one request and both resolve` | PASS (exit 0, 28 pass / 0 fail) | A1 |
| F4-S2 differing-cursor supersession | brief: "differing-cursor second read is rejected with the typed error while the first still resolves" | same | same file — test `a differing-cursor second read is rejected while the first still resolves` (asserts `SessionReadSupersessionError` instance + message; first read resolves; 1 wire request) | PASS (exit 0) | A1 |
| F4-S3 close drains all waiters | brief: "close drains both waiters"; finding 4 close case | same, `server.stop(true)` on the live socket | same file — test `a close drains every coalesced waiter` | PASS (exit 0) | A1 |
| F4-S4 no regression in transport | brief rules: existing behavior intact | same | full-file run: 28 pass, 0 fail, incl. all pre-existing chat/read/error/abort tests | PASS (exit 0) | A1 |
| F4-S5 lint/type/written gates | brief rules: ultracite clean, tsc clean, written any/unknown 0 | CLI gates | `bun x ultracite check --formatter-enabled=false <2 files>`; `cd apps/desktop && bun run check-types`; `bun run check-written-types` | PASS (all exit 0) | A4, A5, A6 |
| F4-S6 patch coverage | brief rules: every changed executable line covered | CLI gate | `bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage` in apps/desktop (exit 0, 441 pass), then `bun run script/check-patch-coverage.ts --base origin/main --glob 'apps/*/coverage/lcov.info' --glob 'packages/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` (exit 0; gateway-transport.ts has zero uncovered changed lines) | PASS | A3, A7 |

## adversarialCases

| scenario | criterion | class | expected | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| F4-A1 mutant kill | brief rule: "tests must be able to fail (prove with one scratch mutant, revert it)" | fault injection — coalesce/supersession branch removed, restoring the silent-replace bug | new tests fail | PASS: 0 pass / 2 fail, exit 1 (first waiter never settles — exactly finding 4); mutant reverted by re-editing, final run 28 pass | A2, A1 |
| F4-A2 socket error / send failure settle | finding 4: "every admitted caller settles on success, session error, socket error and close" | resource failure | pending reads reject instead of hanging | PASS: pre-existing tests `a session-scoped error frame rejects...`, `a socket that closes mid-read rejects...`, `a send failure during a session read rejects instead of hanging` all pass against the new waiter-list paths | A1 |
| F4-A3 desktop-lcov-only patch gate | brief command as literally written (`--glob '<workspace>/coverage/lcov.info'`) | gate-scope mismatch | gate fails closed on the branch-wide diff | OBSERVED: exit 1 with 65 `no coverage record` rows, all outside apps/desktop; none in this lane's file. Full-lcov invocation exits 0. | A7 |
| F4-A4 malformed/hostile frames | parser robustness | malformed input | ignored without settling wrong waiter | PASS: pre-existing `ignores malformed frames...` test passes unchanged over the new code | A1 |
| F4-A5 timing/nondeterminism | no-sleep rule | flaky-test class | all waits are events (held-response server, promise signals) | not_applicable as a failure class: grep shows no setTimeout/setInterval/sleep in the test file (only a doc comment); every wait is an awaited event | A8 |

## artifactRefs

| id | kind | description | path |
| --- | --- | --- | --- |
| A1 | test transcript | final full-file run: 28 pass, 0 fail, exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/final-test-run.txt |
| A2 | test transcript | mutant run: 0 pass, 2 fail, exit 1 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/mutant-run.txt |
| A3 | test transcript | apps/desktop coverage run: 441 pass, 0 fail, exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/coverage-run.txt |
| A4 | gate output | ultracite check, 2 files, clean, exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/ultracite.txt |
| A5 | gate output | apps/desktop tsc (node/web/test), exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/tsc.txt |
| A6 | gate output | written any/unknown types: 0, exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/written-types.txt |
| A7 | gate output | patch coverage (all-lcov invocation), exit 0 | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/patch-coverage.txt |
| A8 | diff | lane diff of both owned files (includes F1-r2's concurrent session_bound edits) | .omo/reports/kernel-campaign-w53/F4-r2-artifacts/lane-diff.patch |
