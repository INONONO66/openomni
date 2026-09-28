# manualQa: check3 — two-process commit fence on one per-session SQLite file

Surface under test: CLI/data-shaped behavior — real OS child processes
(`Bun.spawn` of the bun binary) writing one sqlite file; verdicts come from the
children's JSON stdout, the on-disk `action` table, and process exit codes.
This is the faithful channel for this change (no HTTP/terminal-UI/GUI surface
exists in the spike).

## surfaceEvidence

| scenario id | criterion ref | surface | exact invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| c3-a | TASK "spawns child A (owner A fence 1 rev 0) -> ok:true revision 1" | child process JSON stdout | `cd /Users/ino/Develop/openomni-w51/spike/w5-cluster && /opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check3-fence.test.ts --timeout 60000` (test `a` spawns `bun src/fence-child.ts <file> s-fence A 1 0`) | PASS | a1, a2, a3 |
| c3-b | TASK "child B (owner B fence 2 rev 1) -> ok:false reason 'stale'" | child process JSON stdout | same test file, test `b` spawns `bun src/fence-child.ts <file> s-fence B 2 1` | PASS | a1, a2, a3 |
| c3-c | TASK "child A again (rev 1) -> ok:true revision 2" | child process JSON stdout | same test file, test `c` | PASS | a1, a2, a3 |
| c3-d | TASK "A and B CONCURRENTLY from revision 2: exactly one succeeds (A), B refused 'stale', chain has 3 linked rows" | two concurrent OS processes + readonly sqlite read of `action` table | same test file, test `d` (`Promise.all` on two `Bun.spawn`) | PASS | a1, a2, a3 |
| c3-verify | TASK VERIFY "bun test ... exits 0 twice in a row" | bun test exit code | command above run twice consecutively; `RUN1_EXIT=0`, `RUN2_EXIT=0` (5 pass / 0 fail each) | PASS | a1, a2 |
| c3-receipt | DELIVERABLE 3 "receipt check3-fence.md with outputs, PASS/FAIL, Findings for W5.2" | filesystem | receipt written; SqlRunnerStorage findings sourced from node_modules/effect/src/cluster/SqlRunnerStorage.ts (cluster_locks sqlite branch read directly) | PASS | a3 |

## adversarialCases

| scenario id | criterion ref | adversarial class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| c3-adv-race | check 3 core claim | write race: two processes commit from the same revision simultaneously | exactly one commit lands (holder A, revision 3); loser B refused `"stale"`, no partial row appended (chain length stays 3, prev_hash links intact) | PASS | a1, a2, a3 |
| c3-adv-lock | TASK "SQLite-level fact" | OS-level lock contention: first process holds `BEGIN IMMEDIATE` (prints `HOLDING`, waits on stdin), second writer with CORRECT owner/fence/rev attempts commit | second writer fails within busy_timeout; observed `"SQLITE_BUSY: database is locked"` after ~5128-5134ms (busy_timeout=5000); after stdin release the same write commits (revision 4) | PASS | a1, a2, a3 |
| c3-adv-open | discovered during execution | bootstrap contention: fresh connection's schema preflight runs before `busy_timeout` pragma; concurrent writer triggers instant `SQLITE_BUSY_RECOVERY` (errno 261) at OPEN time | child must not crash silently: fence-child retries open within a bounded 5000ms deadline (mirroring busy_timeout) and otherwise reports the error as JSON with exit 0 | PASS (recorded as a W5.2 gotcha in the receipt) | a3, a4 |
| c3-adv-input | fence-child arg contract | malformed/missing argv | zod tuple parse throws before any DB open; process exits non-zero and the parent test treats it as failure (`fence-child exited N`) — not exercised as a standalone scenario because no product surface passes user input here; args come from the test itself | not_applicable — argv is produced only by our own test harness, never by an external caller in this throwaway spike | a4 |

## artifactRefs

| id | kind | description | path |
|---|---|---|---|
| a1 | test-run log | full `bun test` output, consecutive run 1 (5 pass / 0 fail, exit 0), includes observed SQLITE_BUSY string + elapsed ms | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check3-run1.log |
| a2 | test-run log | full `bun test` output, consecutive run 2 (5 pass / 0 fail, exit 0) | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check3-run2.log |
| a3 | receipt (markdown) | check3 receipt: commands, stdout excerpts, numbers, PASS/FAIL table, Findings for W5.2 on SqlRunnerStorage cluster_locks | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check3-fence.md |
| a4 | source (deliverable) | fence child program (deliverable 1) | /Users/ino/Develop/openomni-w51/spike/w5-cluster/src/fence-child.ts |
| a5 | source (deliverable) | fence test (deliverable 2): 4 fence scenarios + BEGIN IMMEDIATE holder scenario, mkdtemp + afterAll cleanup, bounded-timeout event waits only | /Users/ino/Develop/openomni-w51/spike/w5-cluster/test/check3-fence.test.ts |
