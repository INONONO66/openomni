# Check 1: storage layers boot on sqlite + message round-trips through SqlMessageStorage

Spike files (all new, under `spike/w5-cluster/`):

| file | LOC |
| --- | --- |
| `src/session-file.ts` | 146 |
| `src/session-entity.ts` | 56 |
| `src/runtime.ts` | 32 |
| `test/check1-boot.test.ts` | (4 tests, 20 assertions) |

Also touched: `spike/w5-cluster/tsconfig.json` only (see "tsconfig fix" below).

## Commands run

```
cd /Users/ino/Develop/openomni-w51/spike/w5-cluster
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check1-boot.test.ts --timeout 60000
/opt/homebrew/bin/mise exec bun@1.4.1 -- bunx tsc -p tsconfig.json --noEmit
```

Test output (exit 0; also ran green 3 more consecutive times, 414-707ms per run):

```
test/check1-boot.test.ts:
(pass) a: runtime boots and cluster_* tables exist in the catalog file [10.42ms]
(pass) b: prompts append to OUR hash chain (ordinal 1 then 2, linked prev_hash) [210.59ms]
(pass) c: cluster_messages holds processed rows for the Session entity [0.56ms]
(pass) d: per-session files: s1 exists, s2 gets its own file [41.29ms]

 4 pass
 0 fail
 20 expect() calls
Ran 4 tests across 1 file. [432.00ms]
```

`tsc -p tsconfig.json --noEmit` -> exit 0.

## Sub-checks

### (a) boot + cluster tables on the sqlite dialect - PASS

sqlite_master of the catalog file after layer build:

```
cluster tables: cluster_locks cluster_messages cluster_migrations cluster_replies cluster_runners
```

### (b) prompts append to OUR hash chain - PASS

`sendPrompt("s1","hello")` then `sendPrompt("s1","hello again")` (evidence run, one-off script since the test removes its mkdtemp dir in afterAll):

```
reply 1: {"ordinal":1,"actionHash":"6fbaf0748a16c35bdbd8e62bc993381e6635c1fca80871ae5ebfee6313fe84fb"}
reply 2: {"ordinal":2,"actionHash":"8dd657c611d0fa384e6c72ab2c89a3dfd073b72fb45d540a97429adaf7f290d5"}
chain rows for s1:
{"ordinal":1,"prev_hash":"openomni:l0:genesis:v1","action_hash":"6fbaf074...fe84fb"}
{"ordinal":2,"prev_hash":"6fbaf0748a16c35bdbd8e62bc993381e6635c1fca80871ae5ebfee6313fe84fb","action_hash":"8dd657c6...f290d5"}
```

ordinal 1 -> 2, hashes are 64-hex, row 2 `prev_hash` == row 1 `action_hash`, row 1 `prev_hash` == `GENESIS_PREV_HASH` ("openomni:l0:genesis:v1"). The chain is written by the ledger's `commitSession` (lease fence + CAS revision enforced), NOT by cluster storage.

### (c) message round-trips through SqlMessageStorage - PASS

`SELECT COUNT(*) FROM cluster_messages WHERE entity_type='Session' AND processed=1` -> `2` after two prompts (test asserts >= 1 with a bounded DB-row wait, no bare sleeps). Prompt RPC is annotated `ClusterSchema.Persisted = true`, so every prompt is stored + marked processed in the catalog file.

### (d) per-session files - PASS

`<root>/s1.sqlite` exists after s1 prompts; `sendPrompt("s2","own file")` creates `<root>/s2.sqlite` with its own 1-row chain starting at genesis.

## Import surface used

- Public `@openomni/ledger` surface: `SqliteStorageAdapter` (schema owner; its constructor runs the full sqlite bootstrap) and `type LedgerError`.
- `initialize()` was NOT usable per session: it is a process-global singleton keyed to ONE dbPath (throws on a second path). Per-session files construct `SqliteStorageAdapter` directly and borrow its `testDatabase()` handle.
- SPIKE-ONLY relative deep imports (not on the ledger public surface): `commitSession`, `insertSession`, `selectSession` from `packages/ledger/src/storage/sqlite-l0-write`, and `GENESIS_PREV_HASH` from `packages/ledger/src/storage/l0-hash` (test only).

## tsconfig fix (spike/w5-cluster/tsconfig.json only)

- `rootDir: "."` -> `"../.."`: the deep imports pull ledger/protocol sources into the program, tripping TS6059 otherwise.
- added `allowImportingTsExtensions: true`: pre-existing `src/smoke.ts` and the new files import `./x.ts` (bun style); base tsconfig lacks the flag (TS5097). `noEmit` stays true.

## Findings for W5.2

1. rc.118 cluster lives at `effect/cluster` and `Rpc` at `effect/rpc` (docs/#1196 say `effect/unstable/*` - wrong for rc.118).
2. `Entity.toLayer(buildEffect)` runs the build Effect **per entity activation** with `Entity.CurrentAddress` and a `Scope` in context - the natural place to open the per-session sqlite file; `Effect.addFinalizer` closes it on passivation (entityMaxIdleTime). A real Session entity gets open/close lifecycle for free from the cluster host.
3. Handler param types are NOT contextually inferred through `toLayer`'s generic when the build is an Effect - annotate `envelope: Entity.Request<typeof PromptRpc>` explicitly or you get implicit any.
4. `ClusterSchema.Persisted` must be annotated on the Rpc for messages to land in `cluster_messages`; without it delivery is memory-only. Processed flag is set by reply persistence, and was already visible at the moment the client promise resolved (check c passed with 0.56ms, no wait needed in practice; keep the bounded DB-row wait anyway).
5. `SingleRunner.layer` accepts `shardingConfig` overrides directly (`entityMaxIdleTime`, `entityMessagePollInterval` are `Duration.Input` on `ShardingConfig`); no separate ShardingConfig layer needed. Note it applies them over `ShardingConfig.layerFromEnv`, so ambient `SHARDING_*`-style env vars can still leak into test runs.
6. `commitSession` composes cleanly under a foreign host: caller supplies owner/fence/expectedRevision; refusals surface as `{ok:false, reason: "stale"|"revision"|"inbox"}`. A real Session entity must read the current revision inside the handler (per message), not cache it across mailbox deliveries.
7. `LedgerSession.Commit.fence` must be a positive int and the session row's lease (`lease_owner`/`lease_fence`/`lease_expires_at > now`) must match or the commit refuses with "stale" - the spike pins owner="spike-single-runner", fence=1, expiry=2100-01-01. W5.2's second-writer lane gets the fence conflict for free from this shape.
8. `@openomni/ledger` exposes only `"."` in package exports; anything below (sqlite-l0-write, l0-hash) needs source-relative deep imports. If cluster hosting graduates, ledger should export a narrow "l0 write kernel" surface (commitSession + hash constants).
9. Bun gotcha: running a script that imports the spike sources from OUTSIDE the package tree (e.g. /tmp) auto-resolves `effect` from Bun's global cache (3.22.2) and explodes; always run from within the workspace.

## Verdict

PASS on all four sub-checks; both VERIFY commands exit 0.
