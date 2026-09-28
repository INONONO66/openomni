# manualQa — check 2 (SIGKILL mid-turn crash matrix), task st_01a0e7f8

No ulw-loop plan / attempt dir exists (agentToolkit.status currentAttemptDir = undefined), so artifacts live in the caller's evidence dir `.omo/reports/kernel-campaign-w5-spike/`.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| s1-crash-durable-append | Action 1 committed to our chain before SIGKILL; marker precedes kill | CLI (spawned bun child process, piped stdout) + sqlite data | `Bun.spawn [bun, --tsconfig-override=tsconfig.child.json, src/crash-child.ts, <root>, <catalog>, s-crash, crash]`, then `process.kill(pid, "SIGKILL")` after `APPENDED 1` marker; assert 1 action row, ordinal=1, prev_hash=GENESIS | PASS | a1, a2, a4 |
| s2-mailbox-survives | Unacknowledged mailbox row persists in SqlMessageStorage across SIGKILL | sqlite data (`cluster_messages`, real column `processed`) | readonly `bun:sqlite` query on catalog: 1 CrashSession row `processed=0`, `tag=Turn` | PASS | a1, a2, a4 |
| s3-restart-redelivery | On restart the stored message is redelivered and processed | CLI (restart child) + in-handler event | `bun ... crash-child.ts ... restart`; child prints `REDELIVERED 1 deduped=true action_hash=<same 64-hex as pre-kill>` | PASS | a1, a2, a4 |
| s4-chain-hydration | Chain intact: every row's action_hash == computeActionHash(row), prev_hash links verified | CLI (child recomputes via `packages/ledger/src/storage/l0-hash.computeActionHash`) | child prints `CHAIN_OK 1` post-redelivery and `CHAIN_OK 3` final; test re-asserts kinds `[prompt, fold.checkpoint, prompt]` | PASS | a1, a2, a4 |
| s5-fold-checkpoint | A fold checkpoint commits onto our chain and hydrates as the seed | CLI (real `foldCheckpointAction` + `hydrateSessionHistory` against the session file) | child prints `CHECKPOINT_HYDRATED revision=2 nonCheckpointActions=0 history=0` (0 replayed actions = seed consumed) | PASS | a1, a2, a4 |
| s6-deliverat-residual | DeliverAt-scheduled message fires only after residual delay | CLI + wall clock (clock IS the thing under test) + sqlite `deliver_at` column | child sends `Scheduled` payload (DeliverAt symbol, now+1500ms); prints `DELIVER_AT residual_ms=1517/1604` (runs 1/2); test asserts 1500 <= residual < 3500; `deliver_at` persisted in message row | PASS | a1, a2, a4 |

## adversarialCases

| scenario | criterion | class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| adv1-duplicate-redelivery | Redelivered turn whose append already committed MUST NOT duplicate | at-least-once redelivery / idempotency | handler dedupes via chain key (action.id = turnId): `deduped=true`, chain count stays 1, exactly one `turn-1` row after everything | PASS | a1, a2, a4 |
| adv2-sigkill-mid-handler | SIGKILL while handler blocked mid-turn corrupts nothing | process kill / partial-work | exit 137; sqlite locks released; chain verifies by hash recomputation on restart; no recovery step needed | PASS | a1, a2, a4 |
| adv3-early-fire | DeliverAt message must not fire before its timestamp | timer short-circuit | residual >= 1500 in all three observed runs (1517, 1604, 1513); storage poll gates on `deliver_at <= now` | PASS | a1, a2, a4 |
| adv4-stale-read-claim | Message read by the dead process (`last_read` set) must not be stuck for the 10-minute claim window | stale lease/claim | `Sharding` calls `storage.resetShards` on shard acquisition, clearing `last_read`; observed redelivery ~200ms after restart boot | PASS | a1, a2, a4 |
| adv5-fence-mismatch | Commit fence/CAS refusal paths ("stale"/"revision") | authorization/fencing | not_applicable — fence behavior is explicitly check 3 (out of scope for this task) | not_applicable | — |

## artifactRefs

| id | kind | description | path |
|---|---|---|---|
| a1 | test-log | `bun test test/check2-crash.test.ts` run 1 (exit 0, full child stdout incl. markers, message ids, residual) | .omo/reports/kernel-campaign-w5-spike/check2-run1.log |
| a2 | test-log | same test, consecutive run 2 (exit 0) — repeatability proof | .omo/reports/kernel-campaign-w5-spike/check2-run2.log |
| a3 | receipt | check-2 receipt: commands, excerpts, sub-check table, Findings for W5.2 | .omo/reports/kernel-campaign-w5-spike/check2-crash.md |
| a4 | source | scenario driver + assertions (child program, entity wrapper, test) | spike/w5-cluster/src/crash-child.ts, spike/w5-cluster/src/crash-entity.ts, spike/w5-cluster/test/check2-crash.test.ts |

## Verification summary

- VERIFY condition met: `bun test test/check2-crash.test.ts --timeout 60000` exited 0 twice in a row (a1, a2); an earlier unlogged pair also passed (4 consecutive green runs total).
- Whole spike suite still green after changes: 37 pass / 0 fail across 4 files.
- LSP diagnostics clean on all three written source files.
