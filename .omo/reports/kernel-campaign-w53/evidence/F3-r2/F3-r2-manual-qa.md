# manualQa — F3-r2 (review-r2 finding 3)

No ulw-loop plan exists (`agentToolkit.status().currentAttemptDir` = null), so artifacts live in the caller's evidence directory: `.omo/reports/kernel-campaign-w53/evidence/F3-r2/`. All paths below are relative to that directory unless absolute.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| S1 legacy footer decodes | finding 3: accept version-1 dimensions | CLI/data (production `previousAudit` import, exact issue #1119 footer body) | `B -e 'import { previousAudit } ...'` (see log) | PASS | A2 |
| S2 targeted suite green with coverage | brief: script lane via targeted tests, private coverage dir | CLI (bun test, cwd `script/`) | `B test --config=/dev/null --timeout 300000 --coverage --coverage-reporter=lcov --coverage-dir=/tmp/f3cov/script/coverage quality-audit.test.ts quality-audit-issues.test.ts` | PASS (39/39) | A1 |
| S3 audit dry-run runs end to end | brief: verify with `--dry-run` | CLI (real biome/jscpd/census subprocesses) | `B run script/quality-audit.ts --dry-run` | PASS (exit 0, 784 KB schema-valid preview) | A3 |
| S4 patch coverage gate | rule: every changed executable line covered | CLI gate | `B run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info' --glob '/tmp/f3cov/script/coverage/lcov.info'` | PASS (exit 0) | A4 |
| S5 lane's own uncommitted lines covered | same rule, applied to lines invisible to base...HEAD | CLI/data probe using the gate's own `changedLines`/`lcovUnion`/`uncoveredRows` against private lcov only | `B -e ...` (see log) | PASS (17 changed lines, 0 uncovered) | A5 |
| S6 ultracite clean on changed files | rule: ultracite clean | CLI | `B x ultracite check --formatter-enabled=false <2 files>` | PASS | A6 |
| S7 tsc clean for touched workspace | rule: tsc clean | CLI | `B x tsc -p script/tsconfig.json` | PASS (after `B run build` refreshed stale protocol dist; the sole prior error was in F1-r2's uncommitted `packages/channels/src/websocket.ts`, outside this lane) | A7, A8 |
| S8 written any/unknown = 0 | rule | CLI gate | `B run check-written-types` | PASS (0) | A9 |

## adversarialCases

| scenario | criterion | class | expected | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| X1 invented-zero mutant | tests must be able to fail | scratch mutant (`previous.totals[kind] ?? 0`) | new "not previously measured" test fails | PASS (1 fail, mutant killed, reverted; final diff in A10 has no mutant) | A11 |
| X2 new dimension in current audit vs legacy history | finding 3: no invented zeros, no false regression | missing-history dimension | `regressions()` empty; `planIssues` raises no regression issue; summary still advances with new dims | PASS (test "dimensions absent from history are not previously measured", in A1) | A1, A10 |
| X3 version-1 dimension regression against legacy footer | history must not be blinded by the fix | boundary (2779 -> 2780) | regression issue fires with correct previous/current cells | PASS (test "a version-1 dimension regression still fires", in A1) | A1, A10 |
| X4 corrupted/missing footer | no history reset | malformed input | `previousAudit` throws; `planIssues` throws | PASS (pre-existing test "history corruption is an error, not a new first run" green in A1) | A1 |
| X5 concurrent-lane worktree contamination | lane isolation | shared mutable tree | only the two owned files modified by this lane | PASS (`git status`/`git diff --stat` in receipt; A10 diff limited to owned files) | A10 |
| X6 sleep/timing dependence in new tests | no-sleep rule | nondeterminism | new tests are fully synchronous, no timers | not_applicable — the added tests contain no async paths or waits (pure schema/plan functions) | A10 |

## artifactRefs

| id | kind | description | path |
| --- | --- | --- | --- |
| A1 | test log | targeted quality-audit suites, 39 pass, with lcov coverage | targeted-tests.log |
| A2 | probe log | production `previousAudit` decoding the live issue #1119 footer, exit 0 | probe-issue-1119-footer.log |
| A3 | JSON output | full `--dry-run` preview (audit + issuePlan), exit 0 recorded in receipt | dry-run.json |
| A4 | gate log | check-patch-coverage exit 0, "all changed executable lines are covered" | patch-coverage.log |
| A5 | probe log | worktree-diff patch coverage of this lane's uncommitted lines, 0 uncovered | worktree-patch-coverage.log |
| A6 | gate log | ultracite check on the two changed files, exit 0 | ultracite.log |
| A7 | gate log | tsc -p script/tsconfig.json exit 0 | tsc-script.log |
| A8 | build log | turbo build 7/7 refreshing stale dist before tsc rerun | build.log |
| A9 | gate log | check-written-types exit 0, 0 written any/unknown | check-written-types.log |
| A10 | patch | final diff of the two owned files (HEAD vs worktree) | f3-diff.patch |
| A11 | test log | mutant run: 1 fail on the new regression test | mutant-run.log |
