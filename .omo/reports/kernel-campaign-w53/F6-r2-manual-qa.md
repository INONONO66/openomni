# manualQa — Lane F6-r2 (durable-reconstruction cold-runner timeout)

Change under test: `packages/agent/test/durable-reconstruction.test.ts` only
(child-wait deadline raised to a labeled 60 s exit-signal bound; explicit
per-test timeouts sized above worst-case child sums). CLI/test-shaped
behavior, so CLI invocations with captured logs are the faithful surface.
All bun runs: `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`, cwd
`/Users/ino/Develop/openomni-w53/packages/agent` unless noted,
`/opt/homebrew/bin` stripped from PATH,
`D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python`.
Artifacts live in `F6-r2-artifacts/` beside this file. Receipt: `F6-r2.md`.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| S1 flake-target file 5x loop | brief: "Run the file 5x locally in a loop … all green" | CLI (bun test) | `bun test --config=/dev/null test/durable-reconstruction.test.ts` x5, final bytes | PASS (exits 0,0,0,0,0; 6 pass/0 fail each) | A1 |
| S2 whole agent suite | brief: "`bun run test:ci` once; all green" | CLI (bun test, coverage) | `bun run test:ci` | PASS (exit 0; 852 pass/0 fail/110 files) | A2 |
| S3 tsc clean, touched workspace | brief rules: "tsc clean for touched workspaces" | CLI (tsc x3 projects) | `bun run check-types` | PASS (exit 0) | A3 |
| S4 ultracite clean on changed file | brief rules: "ultracite clean on changed files" | CLI (ultracite) | `bunx ultracite check packages/agent/test/durable-reconstruction.test.ts` (repo root) | PASS (exit 0 after `ultracite fix`; initial check exit 1 was formatting from the added timeout arg — see A5) | A4, A5 |
| S5 written any/unknown | brief rules: "written any/unknown 0" | CLI | `bun run check-written-types` (repo root) | PASS (exit 0; "written any/unknown types: 0") | A6 |
| S6 patch coverage, brief's literal command | brief rules: patch coverage after workspace coverage run | CLI | `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/agent/coverage/lcov.info'` (repo root, after S2's lcov) | PASS for this lane's criterion, command exit 1: zero `packages/agent` lines uncovered; all 49 flagged entries are other lanes' workspaces absent from the single glob (gate diffs the whole 209-file shared branch). This lane's only change is a test file, excluded from gating by the script's `TEST_FILE` rule. | A7 |
| S7 patch coverage, all-lane lcov union | same criterion, tighter attribution | CLI | same script with `--glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` | Same shape: exit 1 with 27 uncovered lines, all in other lanes' `script/` files; `packages/agent` remains zero uncovered. Recorded, not hidden. | A8 |

## adversarialCases

| scenario | criterion | class | expected behavior | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| ADV1 mutant kill | brief rules: "tests must be able to fail (prove with one scratch mutant, revert it)" | oracle deadness | Flipping the refusal path `exit(1)`→`exit(0)` in `test/helpers/durable-reconstruction.ts` must fail the tampered-foldVersion test | PASS: bun exit 1, `0 pass / 1 fail` at `expect(refused.code).toBe(1)`; mutant reverted, `git diff --exit-code` on helper = 0, full file green post-revert (exit 0, 6 pass) | A9, A10 |
| ADV2 timing-luck regression | brief rules: "no sleeps in tests"; brief: bound "not a sleep" | nondeterminism reintroduction | The fix must not add sleeps/polls; the wait must remain the exact child exit+drain signal | PASS by inspection of the final diff: only a `bounded(..., childDeadlineMs)` deadline racing `Promise.all([process.exited, stdout, stderr])` and numeric bun per-test timeouts; no `setTimeout` sleep, no polling added | A11 |
| ADV3 concurrent-lane contamination | caller: stay inside ownership; failures from other lanes must not be absorbed or masked | cross-lane interference | First `test:ci` run failed 3 session-inspection tests while F5-r2's `inspect.ts` src edit was ahead of its test edit; my file was 6/6 green inside that run; rerun after F5's test landed was fully green | PASS (attributed, not fixed or reverted by me; no checkout/stash on foreign files) | A2, A12 |
| ADV4 refusal path waits on wrong signal | brief: "if the refusal path legitimately performs no reconstruction write, the test must wait for the refusal signal instead" | wrong-completion-signal | Verified the refusal (wake) child writes its error witness file and exits 1, and `child()` awaits that exit — the CI timeout was the write-stage child (`reconstruction write` label), not a wait for a never-performed write; label renamed to `… child exit` so future logs name the real signal | not_applicable as a code change (no wrong signal existed); the verification itself PASSes via source inspection and the tampered tests' green runs in A1 | A1, A11 |

## artifactRefs

| id | kind | description | path |
| --- | --- | --- | --- |
| A1 | test log x5 | 5x loop on final bytes, each 6 pass/0 fail, shell exits captured in receipt | F6-r2-artifacts/f6-loop2-1.log … f6-loop2-5.log |
| A2 | test log | final `bun run test:ci`: 852 pass / 0 fail, exit 0 | F6-r2-artifacts/f6-testci2.log |
| A3 | tool log | `bun run check-types` clean, exit 0 | F6-r2-artifacts/f6-tsc2.log |
| A4 | tool log | final ultracite check: clean, exit 0 | F6-r2-artifacts/f6-ultracite2.log |
| A5 | tool log | initial ultracite check exit 1 (format-only diff from added timeout arg) | F6-r2-artifacts/f6-ultracite.log |
| A6 | tool log | check-written-types: 0, exit 0 | F6-r2-artifacts/f6-written.log |
| A7 | gate log | patch coverage, agent-only glob: exit 1, zero agent lines uncovered | F6-r2-artifacts/f6-patchcov.log |
| A8 | gate log | patch coverage, all-lane globs: exit 1, 27 lines all in other lanes' script/ files | F6-r2-artifacts/f6-patchcov-all.log |
| A9 | test log | mutant run: exit 1, 0 pass / 1 fail at refused.code expectation | F6-r2-artifacts/f6-mutant-kill.log |
| A10 | test log | post-revert full-file run: exit 0, 6 pass | F6-r2-artifacts/f6-post-revert.log |
| A11 | diff | final unified diff of the only changed file | F6-r2-artifacts/f6-final-diff.patch |
| A12 | test log | first test:ci run: exit 1, 849 pass / 3 fail, all three in F5-r2's session-inspection suite | F6-r2-artifacts/f6-testci.log |
