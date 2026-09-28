# Check 2 — SIGKILL mid-turn loses nothing (crash / redeliver / DeliverAt)

Date: 2026-09-28. Spike: `spike/w5-cluster` (@openomni/spike-w5-cluster, effect 4.0.0-rc.118, SingleRunner + SqlMessageStorage on a sqlite catalog file, our hash chain in a per-session sqlite file).

## Files added (spike-only)

- `src/crash-entity.ts` — `CrashSession` entity (`Turn` + `Scheduled` rpcs, both `ClusterSchema.Persisted`). Handler appends to OUR chain via `commitSession` with **action.id = turnId** (idempotency key); in `crash` mode it then blocks on a never-resolved `Deferred`. `ScheduledPayload` is a `Schema.Class` implementing the `DeliverAt` protocol (`[DeliverAt.symbol]() => DateTime.makeUnsafe(deliverAtMs)`).
- `src/crash-child.ts` — runnable child, args `<root> <catalogFile> <sessionId> crash|restart`.
- `test/check2-crash.test.ts` — spawns crash child, SIGKILLs it after the `APPENDED 1` marker, asserts durable state, spawns restart child, asserts markers + residual + mailbox rows.
- `tsconfig.child.json` — runtime `paths` mapping for the child (see "workspace wiring" finding).

## Commands run

```
cd /Users/ino/Develop/openomni-w51/spike/w5-cluster
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check2-crash.test.ts --timeout 60000   # run 1: 1 pass, 0 fail, 21 expect() calls [2.17s]
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check2-crash.test.ts --timeout 60000   # run 2: 1 pass, 0 fail, 21 expect() calls [2.05s]
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test --timeout 60000                             # whole spike: 37 pass, 0 fail across 4 files [8.56s]
```

## Evidence (run 2 stdout, exact excerpts)

```
[check2] crash pid=78356 exit=137
APPENDED 1 turn=turn-1 deduped=false action_hash=28ffa3a2fb3b994007788f316585e9dfff7b234266895074e22c2a2e5c6ba6ba at=1790599009916
[check2] cluster_messages after crash: [{"id":"230306757491331072","entity_type":"CrashSession","entity_id":"s-crash","tag":"Turn","processed":0,"deliver_at":null}]
[check2] restart pid=78357 exit=0
REDELIVERED 1 deduped=true action_hash=28ffa3a2fb3b994007788f316585e9dfff7b234266895074e22c2a2e5c6ba6ba at=1790599010093
CHAIN_OK 1
CHECKPOINT_HYDRATED revision=2 nonCheckpointActions=0 history=0
DELIVER_AT residual_ms=1517 t_send=1790599010101 deliver_at=1790599011601 t_handled=1790599011618
CHAIN_OK 3
HYDRATED_FINAL revision=3 nonCheckpointActions=1 history=0
[check2] cluster_messages after restart: [{"id":"230306757491331072",...,"tag":"Turn","processed":1,"deliver_at":null},{"id":"230306758424268800",...,"tag":"Scheduled","processed":1,"deliver_at":1790599011601}]
```

Run 1 equivalents: crash pid=78304/restart pid=78305, message ids 230306724771229696 (Turn) / 230306725784195072 (Scheduled), action_hash aee75266..., residual_ms=1604. Manual dry run: residual_ms=1513.

## Sub-checks

| # | Sub-check | Result | Numbers |
|---|-----------|--------|---------|
| 1 | Action 1 committed before SIGKILL (marker then kill) | PASS | 1 action row; ordinal=1; prev_hash=GENESIS; exit=137 (SIGKILL) |
| 2 | Mailbox row survives kill unacknowledged | PASS | `cluster_messages`: 1 CrashSession row, `processed=0` (real column: `processed BOOLEAN NOT NULL DEFAULT FALSE`) |
| 3 | Restart redelivers from SqlMessageStorage | PASS | `REDELIVERED 1` within ~200ms of boot (redelivery works because `Sharding` calls `storage.resetShards` on shard acquisition, clearing `last_read`; otherwise the 10-minute `last_read` claim window would delay it) |
| 4 | Redelivered turn does NOT duplicate our chain | PASS | `deduped=true`, `CHAIN_OK 1` after redelivery; same action_hash as the pre-kill append; final chain has exactly one `turn-1` row |
| 5 | Chain integrity (recomputed `computeActionHash` + prev_hash links per row) | PASS | `CHAIN_OK 1` then `CHAIN_OK 3` (prompt, fold.checkpoint, prompt) |
| 6 | Fold checkpoint hydrates | PASS | committed a real `foldCheckpointAction` at revision 2; `hydrateSessionHistory` then reports `nonCheckpointActions=0` (seed consumed, zero actions replayed) |
| 7 | DeliverAt fires only after residual delay | PASS | residual_ms = 1517 / 1604 / 1513 across runs, all >= 1500 and < 3500; `deliver_at` persisted in the message row (1790599011601) |

## Findings for W5.2

1. **Duplicate-turn idempotency is OURS, not cluster's.** Cluster redelivery is at-least-once: on restart the handler runs again with the same payload. Without a dedupe key the naive handler would have appended a duplicate chain row (the first append had already committed before SIGKILL). Fix used here: `action.id = turnId` (client-generated, carried in the payload) + a chain lookup before `commitSession`. W5.2 must make the turn id part of the durable envelope→chain contract; `Envelope.primaryKey` / `PrimaryKey.symbol` on the payload could enforce dedupe at storage-save time too, but replay-after-crash still needs the chain-side key.
2. **Checkpoint hydration needs the global ledger singleton, not the agent runtime.** `hydrateSessionHistory` works standalone but reads through `Storage.get()` (process-global, one dbPath). For per-session files this forces `initialize({ dbPath: sessionFile })` — one file per process. W5.2 needs either a handle-scoped SessionHandleStore or one process per session (which the cluster entity model happens to give us).
3. **Spike prompt actions do not project into model context.** `history=0` throughout: our `kind:"prompt"` actions with intent `{text}` are not recognized by `SessionHandleStore.delivery()` (needs the real delivery envelope shape). The checkpoint/hydration mechanics are proven, but W5.2 must write real turn/delivery-shaped actions for history to be non-empty.
4. **DeliverAt semantics observed:** the payload (a `Schema.Class` with `[DeliverAt.symbol]`) is read once at `saveRequest` into the `deliver_at` column; delivery is gated by the storage poll query (`deliver_at <= now`), polled every `entityMessagePollInterval` (100ms here). Residual precision is therefore poll-interval-granular (observed +13..+104ms over the 1500ms target). Local sends do NOT bypass the gate (persisted messages route through the storage read latch). Good enough for retry.scheduled `notBefore` (executor-retry-alarm shape) as long as W5.2 treats DeliverAt as "not before", never "exactly at".
5. **Workspace wiring hazard:** deep-importing `packages/agent/src/**` at runtime fails in a fresh worktree because `@openomni/protocol` resolves via `exports: ./dist/index.js` (unbuilt) and `packages/agent/tsconfig.json` has no `paths`. The ledger deep imports only work because bun applies the nearest tsconfig's `paths` (ledger's). Spike workaround: `bun --tsconfig-override=tsconfig.child.json` mapping all @openomni packages to `src/`. W5.2 should not depend on tsconfig-paths resolution for durable-path code.
6. **SIGKILL containment is clean:** bun:sqlite locks released on process death; restart needed no recovery step beyond normal boot (`resetShards` cleared the stale `last_read` claim). Chain, session row lease (far-future expiry, fence 1) and mailbox all consistent after kill.
