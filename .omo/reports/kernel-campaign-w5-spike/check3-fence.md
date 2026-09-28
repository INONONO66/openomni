# Check 3: commit fence refuses the second writer across OS processes

Proves: two processes opening the same per-session SQLite file cannot both write
the session — OUR commit fence (`commitSession` in
`packages/ledger/src/storage/sqlite-l0-write.ts`: `lease_owner` + `lease_fence`
+ CAS `revision`, all inside one `BEGIN IMMEDIATE` transaction) refuses the
second writer with reason `"stale"` while the holder's commit succeeds. Also
records the raw SQLite-level behavior under a held `BEGIN IMMEDIATE`.

Files (spike-only):
- `spike/w5-cluster/src/fence-child.ts` — child process: args `<file> <sessionId> <owner> <fence> <expectedRevision>`, opens the session db via `openSessionDb` (ledger `SqliteStorageAdapter` bootstrap), attempts one `appendTurnAction`, prints one JSON line `{ok, reason?, revision?}`, exits 0.
- `spike/w5-cluster/test/check3-fence.test.ts` — spawns real child processes (`Bun.spawn` of `process.execPath`) against one session file under a `mkdtemp` dir removed in `afterAll`.

## Commands run

```
cd /Users/ino/Develop/openomni-w51/spike/w5-cluster
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check3-fence.test.ts --timeout 60000
```

Run twice back to back; both exited 0.

## Output (run 1; run 2 identical modulo ms)

```
bun test v1.4.1 (4661e494f)

test/check3-fence.test.ts:
(pass) a: holder A (fence 1, rev 0) commits -> revision 1 [132.24ms]
(pass) b: second writer B (fence 2, rev 1) is refused with reason 'stale' [125.06ms]
(pass) c: holder A commits again (rev 1) -> revision 2 [130.07ms]
(pass) d: CONCURRENT A and B from revision 2 -> exactly one succeeds (A), B 'stale'; chain has 3 linked rows [172.01ms]
check3(e): observed second-writer error after 5128ms: "SQLITE_BUSY: database is locked"
(pass) e: SQLite-level: held BEGIN IMMEDIATE makes the second writer fail SQLITE_BUSY after busy_timeout [5290.06ms]

 5 pass
 0 fail
 20 expect() calls
Ran 5 tests across 1 file. [6.01s]
```

Run 2: same 5 pass / 0 fail, `check3(e)` observed error after 5134ms, total 6.00s, exit 0.

## Sub-checks

| # | Scenario (each writer is a separate OS process) | Expected | Observed | Verdict |
|---|---|---|---|---|
| a | child A, owner `A` fence 1 expectedRevision 0 | `{ok:true, revision:1}` | exact match | PASS |
| b | child B, owner `B` fence 2 expectedRevision 1 | `{ok:false, reason:"stale"}` | exact match | PASS |
| c | child A again, expectedRevision 1 | `{ok:true, revision:2}` | exact match | PASS |
| d | A and B spawned concurrently (`Promise.all`) from revision 2 | exactly one succeeds: A `{ok:true, revision:3}`, B `{ok:false, reason:"stale"}` | exact match; chain has 3 rows, `prev_hash` linked from `GENESIS_PREV_HASH`, all `action_hash` 64-hex | PASS |
| e | holder child opens `BEGIN IMMEDIATE`, prints `HOLDING`, waits on stdin; second writer (correct owner/fence/rev) attempts commit | SQLITE_BUSY within busy_timeout (5000ms) | `"SQLITE_BUSY: database is locked"` after 5128ms (run 2: 5134ms); after stdin release the same write commits -> revision 4 | PASS |

Numbers: 3 fenced commits + 1 post-release commit = 4 chain appends total; refusals never appended (chain length was 3 at the check in (d)). Busy expiry observed at 5128/5134ms against `PRAGMA busy_timeout = 5000`.

## Notes / gotchas hit

- The ledger bootstrap (`initializeSqliteDatabase`) runs a schema preflight read BEFORE applying `PRAGMA busy_timeout = 5000` to the new connection, so under a concurrent writer a fresh open can fail instantly with `SQLITE_BUSY_RECOVERY` (errno 261) instead of waiting. `fence-child.ts` mirrors busy_timeout with a bounded (5000ms) open retry. A real multi-process product path would want the pragma applied before any preflight query.
- The bootstrap also takes its own `BEGIN IMMEDIATE` (migration runner) on every open, so under a held write lock the second process can fail during OPEN, not only during commit — the fence child must catch open-time errors too.
- Refusals surface through `appendTurnAction`'s thrown `commitSession refused (<reason>)`; the child parses the reason back out. Reason `"stale"` is produced by `sessionAuthorityRefusal` (owner/fence mismatch) before any revision check, so B is refused `"stale"` (not `"revision"`) regardless of which process wins the race.

## Findings for W5.2 (SqlRunnerStorage vs our fence, sqlite dialect)

1. On sqlite, `SqlRunnerStorage` uses the `cluster_locks` table (shard_id PK, address, acquired_at): a time-expiring shard lease (`shardLockExpiration`, upsert steals the row when `acquired_at < now - expiry`) refreshed by runner heartbeat — advisory locks are pg/mysql only.
2. That lock is shard-granular runner coordination ("which process should run entities of this shard"), not commit authorization: it carries no fence token and no per-write CAS, so a paused/stale holder can still issue a write after its lock expired.
3. Our fence is checked atomically inside the commit transaction (`lease_owner`/`lease_fence`/`revision` in the same `UPDATE ... WHERE`), which is exactly the property `cluster_locks` lacks; it stays load-bearing.
4. For the single-process SingleRunner design, `cluster_locks`/`cluster_runners` add nothing to write safety over our fence — at most a cheap "another runner is alive" signal at boot; SQLite's own file lock (SQLITE_BUSY, check e) already serializes raw writers but returns errors, not refusal semantics.
5. Keep cluster as host + mailbox + clock; do NOT substitute `cluster_locks` for the ledger lease — if W5.2 ever multi-processes, the fence remains the only correct writer gate and cluster_locks only routes traffic.
