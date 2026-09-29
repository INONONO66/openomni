W5.2: Session entity + per-session SQLite; delete lease/alarm/inbox/migration planes
Part of #930 / W5 #1113. Owner decision 2026-09-27: the per-session process plane moves to **Effect 4 (rc pin) + `effect/unstable/cluster` SingleRunner** over **per-session SQLite files**; the old catalog+1,024-shard+blob design and the 10^7/10^9 benchmark are withdrawn. No Rivet, no fallback runtime, no legacy data migration (fresh schema; old `catalog.db` stays on disk untouched).

## Goal
Replace the hand-built process plane with cluster primitives and shrink storage to per-session files + one small catalog. Ledger truth (action hash chain, commit fence, fold checkpoints, decision facts, policy rows, outbound) stays ours; cluster is host + mailbox + clock only.

## Mapping (main `fc1e5c4d` LOC)
| Concern | Today | After |
| --- | --- | --- |
| single writer per session | lease row + TTL 30s + heartbeat 10s (`sqlite-l0-sessions`, `session/kernel`, `session-turn/-requests/-configuration/-admission`, ~350) | Entity mailbox — **delete** |
| idle sleep / wake | controller close-grace + `wakeSession`/`sweepSessions` (~450 incl. `executor-recovery`) | `entityMaxIdleTime` + message-driven start; checkpoint hydration stays — **half deleted** |
| alarms | `alarm` table + fence CAS + `alarm-worker` 265 + `alarm-sources` 192 (~710) | DeliverAt / DurableClock / ClusterCron; file/line watch resolves a DurableDeferred (~80) — **delete** |
| inbox admission queue | `sqlite-l0-inbox` 107 + kernel inbox fns | SqlMessageStorage; received message still committed as a chain action — **delete** |
| request deadline | alarm projection | DurableDeferred + timeout — **delete** |
| migration plane | runner/statements/schema-lifecycle/u967/u969/decision-fact-migration/historical-* (~1,010) + 42 SQL files (1,096 lines, 50+ tables) | none; 2 fresh schema files (~150 lines) — **delete** |
| action chain + commit fence | `sqlite-l0-write` 546 | unchanged — **keep** |
| fold checkpoints, decision facts, policy, compaction, executor, tool-dispatcher, observation bus, actors/grants/vault | ~17K | unchanged — **keep** |

Expected: ledger −1,470, agent −400, app −380, SQL −950, tests −2.5–4K (lease/alarm/migration/sweep suites) + ~800 cluster integration tests. Prod 23.5K → ~20.5K.

## Composition
`AppLive = Layer.mergeAll(..., SingleRunner.layer({ runnerStorage: "sql" }), SqliteBun.layer(catalog), SessionEntity.layer)`; per-session SqlClient acquired by `Layer.scoped` keyed by the W0.5 generation LayerMap. No new process, no Promise boundary.

## Deletion (grep-zero on merge)
`LEASE_TTL_MS`, `HEARTBEAT_INTERVAL_MS`, `renewLease`, `acquireLease`, `sweepSessions`, `wakeSession`, `createAlarms`, `alarm-worker.ts`, `migration-runner.ts`, `packages/ledger/migration/`, `u967-*`, `u969-*`, `historical-*`. Old `catalog.db` is not read, not migrated, not deleted by code.

## Acceptance
- W5.1 checks 1–5 as real tests (exact events, no sleeps).
- ≥27 distinct crash faults from #1113 re-run on the new plane.
- `docs/kernel-contract.md` storage section, `docs/implementation-status.md`, SLOP lease/alarm/migration rows closed with merge SHA; AGENTS.md ownership row for ledger updated.


## Additional deletion targets (measured 2026-09-27, main `fc1e5c4d`)
These exist only because of the single catalog.db + migration/archive plane and go with it:
- `script/check-ledger-schema-drift.ts` 154, `script/verify-ledger-rename.ts` 135, `script/generate-ledger-archive-manifest.ts` 332, `script/ledger-archive-snapshot.ts` 346, `script/ledger-producer-manifest.ts` 261 = **1,228 prod** + their tests (`generate-ledger-archive-manifest.test` 219, `ledger-archive-fault.test` 90, `ledger-archive-review-r2.test` 513, `verify-ledger-rename.test` 8) = **830 test**. Remove the two commands from `package.json`/CI/AGENTS.md COMMANDS; the drift check is replaced by the fresh schema files being the only DDL.
- `apps/openomni/src/tools/monitor.ts` (140): alarm-table backed; re-express over DeliverAt/DurableDeferred, expected ~70.
- `packages/protocol/src/ledger/l0.ts` (856) and `packages/protocol/src/storage/index.ts` (213): lease/alarm/inbox row schemas leave; expected −300. Protocol stays plain Zod.
- Ledger tests tied to the plane: `alarm.test` 200, `alarm-control.test` 189, `request-alarm-projection.test` 165, `request-migration.test` 420, `migration-guard.test` 160, `u967-disposition-cases` 166, `migration-resolution.test` 168, lease parts of `session/kernel.test` (841) — ~2–2.5K.
- SQL tables: schema declares **57**, prod SQL references **19**, 38 are schema-only (`task work_item todo plan engagement conversation cron_job background_task worker_* pending_ask* event_log ledger_event ledger_head message part transcript_fact wait ...`). Fresh schema target ≈ **15 tables** (session-file: action, decision_fact, fold checkpoint, outbound; catalog: session index, actor_identity, actor_endpoint, person, secret, channel_instance, channel_grant, reply_grant, egress_debit, blacklist, surface_key, policy). `alarm`/`inbox`/`wait`/`delegation` become cluster messages or chain actions.

Revised expectation for this issue: **prod −4,400** (ledger 1,470 + agent 400 + app 450 + script 1,228 + protocol 300 + fresh-schema glue), **SQL −950**, **tests −3.3K to −4.8K** (+~800 new).
