# W5.2 #1197 — Session entity + per-session SQLite; delete lease/alarm/inbox/migration planes

Worktree `/Users/ino/Develop/openomni-w52`, branch `kernel/1197-session-entity-20260928` (base main `5b925d12`), effect `4.0.0-rc.118` exact pin, bun via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`. Draft PR #1239. Spike source of record: `origin/kernel/1196-cluster-spike-20260928:spike/w5-cluster/src/*` (fetched into this worktree's refs). Binding inputs: `.omo/plans/issue-1197.md`, review `/Users/ino/Develop/openomni/.omo/reports/kernel-campaign-w5-spike/review.md` (conditions F1–F6), checks 2/3/4 reports. No git-state changes beyond normal commits by the implementation lanes; never touch the spike branch.

All LOC below are `wc -l` run in this worktree on 2026-09-28 (session `st_01a0e813`).

---

## 1. Target architecture

- `SessionEntity` lives in **`packages/agent/src/cluster/session-entity.ts`** (generic session mechanics per AGENTS.md ownership table); the app composes it with the runner in **`apps/openomni/src/composition/cluster-runtime.ts`**. No new workspace package (avoids review F11's topology-inventory churn).
- One entity type `Entity.make("Session", [...])`, `entityId = sessionId`. Message set (all `ClusterSchema.Persisted`; idempotency key = the durable chain id, checked chain-side before commit, exactly the check2 pattern `action.id = key`):
  `Prompt {messageId, content, origin}` key=`messageId` (chain `msg.received`), `Interrupt {messageId, content, origin}` key=`messageId`, `Resume {messageId, content, origin}` key=`messageId`, `RequestResolve {requestId, inputId, payload, principal}` key=`<requestId>:input:<inputId>`, `RequestCancel {requestId, inputId, principal}` key=`<requestId>:input:<inputId>`, `RetryScheduled {alarmId, attempt, notBefore}` DeliverAt=`notBefore`, key=`<attemptActionId>:retry:<n>`, `Deadline {requestId, deadlineAt}` DeliverAt=`deadlineAt`, key=`<requestId>:deadline`, `WatchFired {watchId, epoch, sourceKey, batch}` key=`Alarm.occurrenceId(watchId, epoch, sourceKey)`, `WatchTimeout {watchId, fireAt}` DeliverAt=`fireAt`, key=`<watchId>:timeout:<epoch>`.
- Per-session file `<sessionsDir>/<sessionId>.sqlite` (`packages/ledger/src/storage/schema-session-file.ts`), 3 tables: `session` (single row: id, parent_id, role, lease_owner, lease_fence, revision, state, tools_generation, system_hash, policy_generation — **no lease_expires_at**), `action` (append-only hash chain, 0041 shape: id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash; `fold.checkpoint`/`outbound`/`inbox.deliver` remain action kinds, not tables), `decision_fact` (0040 shape).
- Catalog `<dataDir>/catalog.sqlite` (`schema-catalog.ts`), 12 tables: `session_index` (id, parent_id, role, fence, created_at), `actor_identity`, `actor_endpoint`, `person`, `secret`, `channel_instance`, `channel_grant`, `reply_grant`, `egress_debit`, `blacklist`, `surface_key`, `policy`; plus the 5 `cluster_*` tables SqlMessageStorage/SqlRunnerStorage create themselves. Old `catalog.db`/`storage.db` is never read, migrated, or deleted.
- Handle-scoped storage (F1): `openCatalogStore(path, sink): CatalogStore` and `openSessionStore(path, sink): SessionStore` (plain classes over `bun:sqlite`, pragma `busy_timeout` applied **before** any preflight read — F9), plus `createSessionKernel(session: SessionStore, catalog: CatalogStore): SessionKernel` (the existing `kernel.ts` API as a returned object). `initialize()`, `Storage.get()`, `Storage` namespace, and `LedgerStorageLive({dbPath})` are deleted; `LedgerCatalogLive({catalogPath, sessionsDir, observationSink})` provides `CatalogStore` + a `SessionStores` opener service.
- AppLive composition (apps/openomni/src/runtime.ts): `AppLive = Layer.mergeAll(appScope, generations, options.llm ?? LlmLive, SessionEntityLive).pipe(Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql", shardingConfig }).pipe(Layer.provide(SqliteClient.layer({ filename: catalogPath })), Layer.provide(BunCrypto))), Layer.provideMerge(LedgerCatalogLive(options)))` — `SqliteClient` from `@effect/sql-sqlite-bun@4.0.0-rc.118`, `BunCrypto` = webcrypto `Crypto.Crypto` layer (spike `crypto.ts`). `shardingConfig` is pinned fully explicit (never `layerFromEnv` ambient — review R2): `entityMaxIdleTime` from config (default 60 s prod, ms-scale in tests), `entityMessagePollInterval: 100ms`.
- W0.5 generation LayerMap: the entity activation (`Entity.CurrentAddress` scope) opens the `SessionStore`, builds `SessionKernel`, and registers it in a process `SessionKernelRegistry` service; `GenerationLayersLive.bundle()` adds `Layer.succeed(SessionKernelService, kernel)` to the per-generation seed so captured generations and tool bodies read the same handle; the activation finalizer closes the file (bounds fds — review R5).
- Fence rotation (F5): on entity activation, catalog CAS `UPDATE session_index SET fence = fence + 1 WHERE id = ? RETURNING fence` inside `BEGIN IMMEDIATE`; the activation then writes `lease_owner = runner:<runnerId>, lease_fence = <fence>` into the session file, refusing if the file's fence is already >= the new fence. `commitSession` keeps owner+fence authorization (expiry predicate deleted with the TTL column); a pre-rotation writer is refused `"stale"` exactly as check3 proved. `cluster_locks` never authorizes writes.
- DeliverAt supersede rule (F2): timer messages are **never cancelled in storage**. Every timer handler is a chain-guarded no-op: `RetryScheduled` acks silently when the attempt already has a terminal result or a newer attempt intent exists; `Deadline` acks silently when `requestById(requestId)` is terminal (resolution tokens `duplicate`/`late_unknown` stay intact — check4 F7); `WatchFired`/`WatchTimeout` dedupe via the committed occurrence id and the watch's chain state. `settle()` disappears; supersede = commit the winning chain action first, let stale timers no-op. Live in-process retry waits keep sleeping the residual (`notBefore - now`); the persisted DeliverAt message is the durable rearm and no-ops when the live path won.
- Admission (F4): the entity handler appends `msg.received` (idempotent) and acks, then drains: it evaluates `decideSessionAdmission` over the **whole chain-derived pending set** (received-not-yet-delivered fold, replacing `pendingInbox`), never head-of-queue; `consume` commits `inbox.deliver` actions **before** acking (check4 F2 ordering). Ack always follows the chain commit.
- Public surface (F6): `packages/agent/src/index.ts` exports `decideSessionAdmission`, `decideRequestTransition` (+ their snapshot/decision types); `packages/ledger/src/index.ts` exports `L0Write` (=`commitSession`, `insertSession`, `selectSession`, `GENESIS_PREV_HASH`, `computeActionHash`). No deep imports anywhere.

## 2. Inventory

Legend: D = delete, M = modify, C = create. LOC from `wc -l` (this worktree). "Δ" is the approximate line delta.

### packages/ledger — src

| Op | Path | LOC | What / why |
|---|---|---|---|
| M | packages/ledger/src/session/kernel.ts | 794 | Becomes `createSessionKernel(session, catalog)` factory returning today's API; delete `LEASE_TTL_MS`, `HEARTBEAT_INTERVAL_MS`, `acquireLease`, `renewLease`, `commitInbox`/`commitReceivedMessage` inbox-table paths (pending set becomes a chain fold `pendingMessages()`); keep every read/commit/fold function. Δ ~-150 |
| C | packages/ledger/src/session/default-kernel.ts | ~60 | TEMP wave-1 adapter: module-level `SessionHandleStore` delegating to a process-default kernel so wave 1 stays green. **Deleted by lane L3.1.** |
| C | packages/ledger/src/storage/schema-session-file.ts | ~90 | Fresh DDL: session, action, decision_fact + indices; the only session-file DDL owner. |
| C | packages/ledger/src/storage/schema-catalog.ts | ~100 | Fresh DDL: 12 catalog tables + indices; the only catalog DDL owner. |
| C | packages/ledger/src/storage/session-store.ts | ~120 | `openSessionStore(path, sink)`: busy_timeout-first open (F9), bootstrap via schema-session-file, exposes sessions/actions/decisionFacts sub-adapters + `transaction`. |
| C | packages/ledger/src/storage/catalog-store.ts | ~140 | `openCatalogStore(path, sink)`: busy_timeout-first open, bootstrap via schema-catalog, exposes surfaceKey/egress/actors/blacklist/grants/provisioning/policy sub-adapters + `session_index` fence CAS `rotateFence(sessionId): number`. |
| M | packages/ledger/src/storage/sqlite-l0-write.ts | 546 | KEEP the hash chain + fence (F5). Drop `lease_expires_at` from selects/updates and the expiry predicates (lines 208–241, 435–438); drop `releaseLease`; fence check = owner+fence equality only. Export surface for `L0Write`. Δ ~-40 |
| M | packages/ledger/src/storage/sqlite-l0-sessions.ts | 192 | Delete `acquireLease`/`renewLease`/sweep-support; keep materialize/get/list/openChildCount over the new row shape. Δ ~-90 |
| M | packages/ledger/src/storage/sqlite-l0-adapter.ts | 34 | Drop `createAlarms`/inbox wiring; adapters composed by session-store/catalog-store instead. Δ ~-15 |
| M | packages/ledger/src/storage/sqlite-l0-rows.ts | 195 | Drop lease_expires_at, alarm and inbox row mappers. Δ ~-60 |
| M | packages/ledger/src/storage/sqlite-action-reads.ts | 253 | Keep; add `pendingMessages` fold read (msg.received without inbox.deliver). Δ ~+40 |
| M | packages/ledger/src/storage/l0-action-builders.ts | 115 | Keep checkpoint/occurrence builders; add `msgReceivedAction`; delete `requestDeadline` alarm-row projection (deadline is a DeliverAt message; the request CAS stays chain-side). Δ ~-20/+15 |
| M | packages/ledger/src/storage/l0-hash.ts | 79 | Keep hashing; delete `ACTION_HASH_MIGRATION`. Δ ~-15 |
| M | packages/ledger/src/storage/sqlite-storage.ts | 94 | Rebuilt as thin composition used by catalog-store/session-store (or folded into them); the one-Database-all-capabilities adapter form goes. Δ ~-60 |
| D | packages/ledger/src/storage/storage.ts | 156 | Process-global `Storage` namespace singleton (F1). |
| D | packages/ledger/src/storage/initialize.ts | 39 | One-dbPath `initialize()` (F1). |
| D | packages/ledger/src/storage/sqlite-l0-alarms.ts | 254 | Alarm table plane (`createAlarms`). |
| D | packages/ledger/src/storage/sqlite-l0-inbox.ts | 107 | Inbox table plane. |
| D | packages/ledger/src/storage/sqlite-schema-lifecycle.ts | 129 | Migration-list bootstrap; fresh schema files replace it. |
| D | packages/ledger/src/storage/migration-runner.ts | 109 | Migration plane. |
| D | packages/ledger/src/storage/migration-statements.ts | 64 | Migration plane. |
| D | packages/ledger/src/storage/decision-fact-migration.ts | 75 | Migration plane. |
| D | packages/ledger/src/storage/u967-preflight.ts | 77 | u967-*. |
| D | packages/ledger/src/storage/u967-projection.ts | 178 | u967-*. |
| D | packages/ledger/src/storage/u969-preflight.ts | 126 | u969-*. |
| D | packages/ledger/src/storage/historical-projections.ts | 37 | historical-*. |
| D | packages/ledger/src/storage/historical-request-format.ts | 214 | historical-*. |
| D | packages/ledger/migration/ (42 dirs, 1,096 SQL lines) | 1096 | Whole migration plane; fresh schema only. |
| M | packages/ledger/src/layers.ts | 50 | `LedgerStorageLive({dbPath})` → `LedgerCatalogLive({catalogPath, sessionsDir, observationSink})` providing CatalogStore + SessionStores opener; `LedgerLive` reworked over handles. Δ ~+20 |
| M | packages/ledger/src/services.ts | 47 | Drop `AlarmWriteAdapter`/`InboxWriteAdapter`/`LeaseReceipt`; `LedgerWrites` = session/catalog handle ports. Δ ~-15 |
| M | packages/ledger/src/index.ts | 20 | Export `L0Write`, `openCatalogStore`, `openSessionStore`, `createSessionKernel`, `SessionKernel`; drop `initialize`/`Storage` (wave 1 keeps TEMP `SessionHandleStore` re-export until L3.1). Δ ~+8 |
| M | packages/ledger/src/storage/index.ts | 4 | Re-export new store modules. |
| M | packages/ledger/bench/seed-turn-history.ts | 94 | Seed via `openSessionStore` + kernel handle instead of `initialize()`/lease. Δ ~-10 |

### packages/ledger — test

| Op | Path | LOC | What |
|---|---|---|---|
| D | test/storage/alarm.test.ts | 200 | alarm table plane |
| D | test/storage/alarm-control.test.ts | 189 | alarm table plane |
| D | test/storage/request-alarm-projection.test.ts | 165 | deadline alarm projection |
| D | test/storage/request-migration.test.ts | 420 | migration plane |
| D | test/storage/migration-guard.test.ts | 160 | migration plane |
| D | test/storage/migration-statements.test.ts | 78 | migration plane |
| D | test/storage/message-migration.test.ts | 53 | migration plane |
| D | test/storage/watch-migration.test.ts | 97 | migration plane |
| D | test/storage/reply-grant-migration.test.ts | 85 | migration plane |
| D | test/storage/u967-disposition-cases.ts | 166 | u967-* |
| D | test/migration-resolution.test.ts | 168 | migration plane |
| D | test/storage/initialize.test.ts | 111 | singleton API |
| M | test/session/kernel.test.ts | 841 | Delete lease acquire/renew/TTL sections (~-300); port the rest to `createSessionKernel` handles. |
| M | test/session/commit-fencing.test.ts | 138 | Fence-only authorization (no expiry rows); add rotation refusal case. |
| M | test/session/message-commit.test.ts | 366 | Received-message path = chain `msg.received` fold, no inbox rows. |
| M | test/session/message-deadline.test.ts | 313 | Deadline CAS stays chain-side; timer arrival becomes an entity `Deadline` no-op/terminal test (moves off alarm rows). |
| M | test/session/write-discipline.test.ts | 441 | Handle-scoped writers. |
| M | test/session/received-message.test.ts | 72 | Chain-fold pending. |
| M | test/session/request-storage.test.ts | 89 | Handle-scoped. |
| M | test/session/events.test.ts | 36 / bounded-reads / lineage / materialize / outbound-projection / public-surface / read-ports (same dir) | Mechanical: construct kernel via factory; public-surface adds L0Write. |
| M | test/storage/storage-boundaries.test.ts | 533 | Rewrite over CatalogStore/SessionStore fail-closed semantics (replaces Storage.get() boot-order tests). |
| M | test/storage/sqlite-storage.test.ts | 478 | Rewrite: fresh-schema bootstrap of both stores, WAL close semantics. |
| M | test/storage/adapter-contracts.test.ts | 487 | Drop alarm/inbox sub-adapter contracts; keep the rest over catalog-store. |
| M | test/storage/effect-write-ports.test.ts | 362 | LedgerCatalogLive ports. |
| M | test/storage/process-layers.test.ts | 190 | LedgerCatalogLive acquire/release. |
| M | test/storage/fail-closed.test.ts | 60 | Handle-absence refusals. |
| M | test/storage/sqlite-busy.test.ts | 34 | busy_timeout-before-preflight (F9) regression. |
| M | test/storage/request-count-cas.test.ts | 206, test/storage/request-atomicity.test.ts 80, write-refusals 74, action-hash-chain / decision-fact* / policy-generation / read-validation / json-boundaries / surfaces / session-bundles / atomic-file (same dir) | Mechanical handle-factory port; no contract change. |
| M | test/helpers/request.ts | 106 | Kernel-handle fixture. |
| C | test/session/fence-rotation.test.ts | ~200 | W5.1 check3 + F5 as a package test (see §4). |
| C | test/storage/session-store.test.ts | ~150 | Fresh session-file bootstrap, 3-table census, busy-first pragma. |
| C | test/storage/catalog-store.test.ts | ~150 | Catalog bootstrap, 12-table census, `rotateFence` CAS under concurrency. |

### packages/protocol

| Op | Path | LOC | What |
|---|---|---|---|
| M | packages/protocol/src/ledger/l0.ts | 855 | `LedgerSession`: Row drops `leaseExpiresAt`; delete `AcquireLease`/`RenewLease`; `Commit` drops `releaseLease`/`consumeInboxIds` (delivery evidence = `inbox.deliver` actions). `Inbox`: keep `Row`/`Kind` as the pending-projection shape, delete `Commit` storage form. `Alarm`: keep `RetrySchedule` + `occurrenceId` + watch spec (ride in payloads/chain), delete Row/arm/fire/cancel storage shapes. Δ ~-300 (issue's measured target). Protocol stays plain zod. |
| M | packages/protocol/src/storage/index.ts | 212 | Delete `AlarmSubAdapter`/`InboxSubAdapter` and lease methods from `SessionSubAdapter`. Δ ~-70 |

### packages/agent — src

| Op | Path | LOC | What |
|---|---|---|---|
| C | packages/agent/src/cluster/session-entity.ts | ~260 | Entity + `toLayer` handler: activation = rotate fence (catalog CAS) → open SessionStore → build kernel → register in SessionKernelRegistry → resume open turns (`executor-recovery` semantics); per message: idempotent chain append → whole-backlog admission drain (F4) → run turn via SessionRunner port → ack after commit. Finalizer closes the file (passivation). |
| C | packages/agent/src/cluster/messages.ts | ~140 | The 9 Rpc schemas of §1 incl. DeliverAt `Schema.Class` payloads. |
| C | packages/agent/src/cluster/timers.ts | ~120 | `RetryTimerPort` (arm = commit `retry.scheduled` chain action + self-send `RetryScheduled`; live residual sleep kept), `Deadline`/`WatchTimeout` senders, all no-op guards of F2. |
| C | packages/agent/src/cluster/kernel-registry.ts | ~50 | `SessionKernelService` Context tag + per-process registry keyed by sessionId. |
| M | packages/agent/src/session-handle.ts | 151 | Delete `SessionRegistry`, `wakeSession`, `sweepSessions`, `closeSessions`, `getSessionHandle`; `session()` becomes materialize (catalog session_index + session file) + entity-client facade returning `SessionHandle` whose prompt/interrupt/resume/get/watch route through the client/kernel. Δ ~-60/+50 |
| M | packages/agent/src/session-controller.ts | 338 | Controller loses the close-grace lease window and self-wake loop (entity mailbox + `entityMaxIdleTime` own lifecycle); keeps reconcile/turn-run mechanics invoked from the entity handler. Δ ~-120 |
| M | packages/agent/src/session-turn.ts | 254 | Delete heartbeat/`renewLease` scheduling (lines 62–67); fence pinned at activation. Δ ~-40 |
| M | packages/agent/src/session-requests.ts | 219 | `acquireLease` (l.92) → activation fence from kernel context; request commands arrive as entity messages. Δ ~-30 |
| M | packages/agent/src/session-configuration.ts | 84 | Same for l.63. Δ ~-15 |
| M | packages/agent/src/executor.ts | 504 | `closeGraceMs ?? LEASE_TTL_MS` (l.251) → explicit option; retryAlarm port type swap. Δ ~-10 |
| D | packages/agent/src/executor-retry-alarm.ts | 51 | Replaced by cluster/timers.ts. |
| M | packages/agent/src/executor-context.ts | 124 | `retryAlarm` → `retryTimer` port. Δ ~10 |
| M | packages/agent/src/executor-recovery.ts | 223 | Keep recover(); drop alarm-row consumption branch. Δ ~-20 |
| M | packages/agent/src/session-admission.ts | 408 | Unchanged decisions; snapshot `pending` fed from chain fold; **exported** (F6). Δ ~5 |
| M | packages/agent/src/session-request.ts | 628 | `decideRequestTransition` exported (F6); deadline input arrives as timer message. Δ ~10 |
| M | packages/agent/src/session-contract.ts | 249 | Runtime gains SessionRunner/entity ports; drop closeGrace lease wording. Δ ~15 |
| M | packages/agent/src/session-lifecycle/history.ts | 416 | `Storage.get()` reads → kernel handle param (hydrate/fold/checkpoint commit). Δ ~-20 |
| M | packages/agent/src/session-lifecycle/inspect.ts | 386 | Kernel handle param. Δ ~-10 |
| M | packages/agent/src/session-fold-commit.ts | 128, session-record.ts 361, session-outbound.ts 130, session-stop-evidence.ts 55, session-parent-reply.ts 33, model-selection.ts 78, compaction/successor.ts, session-generations.ts 141, session-chat-runner.ts 56, session-message-observation.ts 25 | Mechanical: `SessionHandleStore.` static calls → injected `SessionKernel` (via services/params). Δ small each |
| M | packages/agent/src/services.ts | 61 | Add `SessionKernelService` to SessionEntryServices. Δ ~+10 |
| M | packages/agent/src/index.ts | 39 | Export decideSessionAdmission/decideRequestTransition/cluster surface; drop wake/sweep exports. Δ ~+8 |
| M | packages/agent/src/layers.ts | 16, bundle.ts 259 | Wire new services. Δ small |
| M | packages/agent/package.json | – | devDependency `@effect/sql-sqlite-bun@4.0.0-rc.118` (integration tests). |

### packages/agent — test

| Op | Path | LOC | What |
|---|---|---|---|
| M | test/crash-matrix.test.ts | 711 | Port all 27 cells to the entity plane (see §4): child worker boots the cluster runtime on a per-session file + catalog instead of `Storage.initialize({dbPath})`; lease-witness fields become fence-rotation witness; `recoverRetryAlarm` consumes the redelivered DeliverAt no-op instead of `alarms.cancel`. |
| M | test/helpers/crash-matrix.ts | 420 | Same port: `stop()` witness drops `leaseExpiresAt`, keeps owner/fence; `crashMatrixMain` opens stores via handles. |
| M | test/helpers/crash-configure.ts 105, crash-message-plane.ts 137, crash-reconstruction.ts 208, fold-crash.ts 184, durable-reconstruction.ts 153 | – | Handle-scoped storage + entity-plane wake (doorbell = redelivered message, not alarm row). |
| M | test/helpers/session-services.ts 82, service-layers.ts 64, request-ledger.ts 173, effect-g1.ts 87, g0-request-ledger.ts 101, native-executor.ts 61, session-request-plane.ts 88, crash-channel/receive-outbound/etc. (same dir) | – | Fixture port to kernel handles; no new Effect runner sites (reuse `runAgent`/`isolated` allowlist entries). |
| D | test/retry-rearm.test.ts | 62 | Alarm-row rearm; superseded by entity-timers tests. |
| M | test/session-handle.test.ts | 2614 | Largest single port: registry/wake/sweep sections deleted, entity-facade + kernel-handle sections replace them; grep targets `wakeSession`/`sweepSessions` go to zero here. Δ ~-600/+400 |
| M | test/session-fsm.test.ts 392, session-lifecycle-conformance.test.ts 1756, session-inspection.test.ts 511, session-outbound.test.ts 313, session-request-port.test.ts 248, session-resume-reopen.test.ts 227, session-failure-boundaries.test.ts 185, executor-recovery.test.ts 669, session-admission/request/record suites, core/policy/native-tool-pre-dispatch.test.ts 123 | – | Mechanical handle/entity port; conformance harness keeps its six registrations, driving the entity handler instead of the controller loop. |
| C | test/cluster/entity-boot.test.ts | ~250 | W5.1 check1 (§4). |
| C | test/cluster/entity-crash.test.ts | ~320 | W5.1 check2 + R3 dedupe + F12 real shapes (§4). |
| C | test/cluster/entity-admission.test.ts | ~400 | W5.1 check4 A01–A17/B1–B8 + C1/C2 on the real entity (§4). |
| C | test/cluster/entity-passivation.test.ts | ~140 | F3/R1 (§4). |
| C | test/cluster/entity-timers.test.ts | ~220 | F2 supersede matrix (§4). |
| C | test/cluster/sharding-config.test.ts | ~60 | R2 env-override pin (§4). |
| C | test/helpers/cluster-runtime.ts | ~130 | `makeTestClusterRuntime({sessionsDir, catalogFile, idleMs})`; effects run through existing `runAgent`/`isolated` helpers so the runner-site ratchet does not grow. |
| C | test/helpers/cluster-crash-child.ts | ~160 | SIGKILL child (spike crash-child shape, real packages, no tsconfig shim — F6 makes deep imports unnecessary). |

### apps/openomni

| Op | Path | LOC | What |
|---|---|---|---|
| M | src/runtime.ts | 39 | AppLive line of §1. Δ ~+20 |
| C | src/composition/cluster-runtime.ts | ~80 | SingleRunner + SqliteClient(catalog) + BunCrypto + SessionEntityLive wiring, explicit ShardingConfig. |
| C | src/composition/cluster-crypto.ts | ~15 | BunCrypto layer (spike crypto.ts). |
| M | src/index.ts | 597 | Boot: delete `createAlarmWorker` start (ll.474–488), `sweepSessions` recovery (l.541), `wakeSession` monitor path (l.397) — wake = entity client send; runner resolution registered as the entity's SessionRunner port. Δ ~-90 |
| M | src/process-entry.ts | 136 | Same boot rewiring for worker entry. Δ ~-25 |
| M | src/config.ts | 320 | `dbPath` → `catalogPath` (default `~/.openomni/catalog.sqlite`) + `sessionsDir` (default `~/.openomni/sessions`) + `entityIdleMs`; `OPENOMNI_DB_PATH` ignored (old file untouched). Δ ~+25 |
| M | src/cli/daemon.ts 260, src/cli/doctor.ts 121, src/cli/main.ts 205 | – | Config plumbing; doctor notes legacy `storage.db` is inert. Δ small |
| D | src/composition/alarm-worker.ts | 265 | Alarm plane. |
| D | src/composition/alarm-sources.ts | 192 | Alarm plane. |
| C | src/composition/watch-sources.ts | ~120 | PTY/path watch OS-handle holders (kept mechanics from alarm-sources) that send `WatchFired` entity messages; timeout armed as `WatchTimeout` DeliverAt. |
| M | src/tools/monitor.ts | 81 | Re-express over watch-sources + DeliverAt (issue: ~70 target); output = watch chain state, not Alarm.Row. Δ ~-15 |
| M | src/tools/core/monitor-ports.ts | 72 | Ports over entity client + watch-sources. Δ ~-20 |
| M | src/composition/generation-layers.ts | 137 | Seed layer gains `SessionKernelService` from the registry (§1). Δ ~+20 |
| M | src/composition/message-session.ts 251, ingress-executor.ts 55, message-decision.ts 20, terminal-message.ts 65, process-session.ts 106, process-replies.ts 66, boot.ts 13 | – | Ingest path: gateway delivery = entity client `Prompt`/`Interrupt`/`Resume` send; `SessionHandleStore.` statics → kernel/catalog reads. Δ moderate |
| M | src/gateway.ts | 350 | Session delivery via entity client (gateway stays a sanctioned runner site). Δ ~+15 |
| M | src/resident.ts 136, src/channels.ts 216, src/shutdown.ts 16 | – | Runner-port registration; shutdown = runtime dispose (entities passivate). Δ small |
| M | package.json (apps/openomni) | – | dependency `@effect/sql-sqlite-bun@4.0.0-rc.118`. |

apps/openomni — test:

| Op | Path | LOC | What |
|---|---|---|---|
| D | test/alarm-worker-boundaries.test.ts | 195 | alarm plane |
| D | test/alarm-worker-errors.test.ts | 98 | alarm plane |
| M | test/alarm-boot-durability.test.ts | 170 | → timer-boot durability on DeliverAt redelivery (rename to test/timer-boot-durability.test.ts). |
| M | test/helpers/alarm.ts | 169 | → helpers/watch.ts fixture over watch-sources (keeps its 2 allowlisted runner entries by keeping the file path, or entries are removed — ratchet may shrink, never grow). |
| M | test/monitor-occurrence.test.ts 294, monitor-dispatcher.test.ts 298, monitor-message-controls.test.ts 166, monitor-tool-boundaries.test.ts 106 | – | Monitor over the watch plane; occurrence identity/budget assertions unchanged (chain-side). |
| M | test/boot-wiring.test.ts 517, gateway-contracts.test.ts 324, e2e.test.ts 363, process-session-e2e.test.ts 308, session-wave-e2e.test.ts 1003, helpers/session-wave.ts 145, helpers/resident-runner.ts 71, session-tool-recovery-e2e.test.ts 231, resident-llm-resilience.test.ts 249, resident-authority.test.ts 86, request-owner-e2e.test.ts 320, helpers/request-owner-process.ts 184, outbound-inbox-binding.test.ts, monitor-*.test remainder | – | Entity-plane port: lease contender helpers become fence-rotation contenders; wake = message send. |
| M | test/config.test.ts 332, cli-entry.test.ts 547, cli.test.ts 832, npm-package.test.ts 198 | – | catalogPath/sessionsDir config surface. |

### packages/channels

| Op | Path | LOC | What |
|---|---|---|---|
| M | test/helpers/requests.ts | 182 | LEASE fixture → fence fixture. |
| M | test/owner-answer.test.ts | 437 | Same. |

### script / CI / docs

| Op | Path | LOC | What |
|---|---|---|---|
| D | script/check-ledger-schema-drift.ts | 154 | Fresh schema files are the only DDL. |
| D | script/verify-ledger-rename.ts | 135 | + its test. |
| D | script/generate-ledger-archive-manifest.ts | 332 | Archive plane. |
| D | script/ledger-archive-snapshot.ts | 346 | Archive plane. |
| D | script/ledger-producer-manifest.ts | 261 | Archive plane. |
| D | script/generate-ledger-archive-manifest.test.ts | 219 | |
| D | script/ledger-archive-fault.test.ts | 90 | |
| D | script/ledger-archive-review-r2.test.ts | 513 | |
| D | script/verify-ledger-rename.test.ts | 8 | |
| D | script/alarm-type-contract.test.ts | 69 | Alarm storage-shape contract; timer payloads are schema-typed in cluster/messages.ts. |
| M | script/effect-service-contract.test.ts | 65 | LedgerWrites shape update. |
| M | script/request-authority-census.ts (+ script/conformance/request-authority-census.test.ts) | – | Drop historical-* references. |
| M | script/conformance/crash-matrix.json | 27 rows | Rename `alarm_fire_committed_before_hibernated_doorbell` → `watch_fired_committed_before_entity_wake`, `retry_backoff_wait` note text; count stays 27 (§4). |
| M | AGENTS.md | – | Delete COMMANDS lines 185–186 (`verify-ledger-rename`, `check-ledger-schema-drift`); update ledger ownership row (l.225) + stamp (l.3); lint:docs regen. |
| M | .github/workflows/ci.yml (+ script/ci.ts, script/scripts-lanes.test.ts, script/gate-discovery.test.ts if they enumerate the deleted scripts) | – | Remove deleted-script steps; verify with `bun run ci:plan`. |
| M | docs/kernel-contract.md | – | §2 "Durable session identity and runtime ownership" (lease/heartbeat → entity mailbox + fence rotation), "Alarm and monitor baseline" (watch plane over DeliverAt), §6 storage paragraphs (per-session files + catalog, fresh schema). |
| M | docs/implementation-status.md | – | W5.2 entry: what landed, crash-matrix mapping, NOT-in-W5.2 list. |
| M | docs/SLOP.md | – | Lease/alarm/migration rows closed with merge SHA. |
| M | docs/kernel-references.md | – | l.27 import path `effect/unstable/cluster` → `effect/cluster` (rc.118 fact). |

Net: prod ~-4,400, SQL -1,096, tests ~-3.5K/+~1.9K — consistent with the issue's revised expectation.

## 3. Waves and lanes

Lanes are single agents on THIS worktree; write scopes are disjoint by file within a wave; waves are sequential. Every wave ends green: `mise exec bun@1.4.1 -- bun run check-types && bun test` (scoped commands per lane below; full chain in wave 4).

### Wave 1 — foundation (build + tests stay green; old planes still run)

- **L1.1 public surface + F9**
  - Write: `packages/agent/src/index.ts`, `packages/ledger/src/index.ts`, `packages/ledger/src/storage/sqlite-schema-lifecycle.ts` (pragma-before-preflight only), `packages/ledger/test/session/public-surface.test.ts`, `packages/ledger/test/storage/sqlite-busy.test.ts`.
  - Reads: review F6/F9, check3 notes. Deliverables: `decideSessionAdmission`/`decideRequestTransition`/`L0Write` exported; busy_timeout applied before any preflight query.
  - Verify: `mise exec bun@1.4.1 -- bun test packages/ledger/test/storage/sqlite-busy.test.ts packages/ledger/test/session/public-surface.test.ts && bun run check-types && bun run script/check-dead-exports.ts`. Stop: exports resolvable from package indexes, F9 test green.
- **L1.2 handle-scoped storage + fresh schema (F1)**
  - Write: `packages/ledger/src/storage/{schema-session-file.ts,schema-catalog.ts,session-store.ts,catalog-store.ts}` (new), `packages/ledger/src/session/kernel.ts` (factory form), `packages/ledger/src/session/default-kernel.ts` (TEMP, deleted by L3.1), `packages/ledger/src/storage/index.ts`, `packages/ledger/test/storage/{session-store,catalog-store}.test.ts` (new).
  - Deliverables: both stores open/bootstrap fresh files; kernel factory passes existing kernel.test via the TEMP default-kernel shim (old `SessionHandleStore` API unchanged for consumers this wave).
  - Verify: `mise exec bun@1.4.1 -- bun test packages/ledger && bun run check-types`. Stop: ledger suite green with zero consumer edits outside packages/ledger.
- **L1.3 deps + config + crypto scaffolding**
  - Write: `apps/openomni/package.json`, `packages/agent/package.json`, `apps/openomni/src/config.ts`, `apps/openomni/src/composition/cluster-crypto.ts` (new), `apps/openomni/test/config.test.ts`.
  - Deliverables: `@effect/sql-sqlite-bun@4.0.0-rc.118` installed (lockfile already resolves it via the spike); catalogPath/sessionsDir config with defaults; no behavior change (new config unused yet).
  - Verify: `mise exec bun@1.4.1 -- bun install && bun test apps/openomni/test/config.test.ts && bun run script/check-deps.ts && bun run script/check-topology.ts`. Stop: install + gates green.

### Wave 2 — entity plane (old planes still present; new plane proven)

- **L2.1 entity + fence rotation**
  - Write: `packages/agent/src/cluster/{session-entity.ts,messages.ts,kernel-registry.ts}` (new), `packages/agent/src/services.ts`, `packages/agent/src/session-contract.ts`, `packages/ledger/test/session/fence-rotation.test.ts` (new), `packages/ledger/src/storage/catalog-store.ts` (rotateFence — coordinated: L1.2 author owns it; this lane only consumes; if a change is needed it lands here since L1.2 closed).
  - Deliverables: activation opens store, rotates fence via catalog CAS, drains backlog per F4, ack-after-commit; fence-rotation test green (stale writer refused).
  - Verify: `mise exec bun@1.4.1 -- bun test packages/ledger/test/session/fence-rotation.test.ts packages/agent && bun run check-types`. Stop: rotation + agent suites green.
- **L2.2 timers + monitor plane (F2)**
  - Write: `packages/agent/src/cluster/timers.ts` (new), `packages/agent/src/executor-context.ts`, `packages/agent/src/executor-recovery.ts`, `packages/agent/src/executor.ts`, `apps/openomni/src/composition/watch-sources.ts` (new), `apps/openomni/src/tools/monitor.ts`, `apps/openomni/src/tools/core/monitor-ports.ts`, `packages/agent/test/cluster/entity-timers.test.ts` (new).
  - Deliverables: retry/deadline/watch over DeliverAt with chain-guarded no-ops; `executor-retry-alarm.ts` still present (deleted L3.2) but production path switched behind the port.
  - Verify: `mise exec bun@1.4.1 -- bun test packages/agent/test/cluster/entity-timers.test.ts apps/openomni/test/monitor-tool-boundaries.test.ts && bun run check-types`. Stop: supersede matrix green.
- **L2.3 app composition + ingress**
  - Write: `apps/openomni/src/composition/cluster-runtime.ts` (new), `apps/openomni/src/runtime.ts`, `apps/openomni/src/index.ts`, `apps/openomni/src/process-entry.ts`, `apps/openomni/src/gateway.ts`, `apps/openomni/src/composition/{message-session.ts,ingress-executor.ts,message-decision.ts,terminal-message.ts,generation-layers.ts,boot.ts}`, `apps/openomni/src/resident.ts`, `apps/openomni/src/shutdown.ts`, `apps/openomni/src/cli/{daemon.ts,doctor.ts,main.ts}`.
  - Deliverables: AppLive per §1; gateway/session delivery through the entity client; boot has no sweep/alarm-worker start (recovery = entity activation resume); runner-site count unchanged (main.ts/gateway.ts only).
  - Verify: `mise exec bun@1.4.1 -- bun test apps/openomni && bun run script/check-effect-boundaries.ts && bun run check-types`. Stop: app e2e suites green on the entity plane.
- **L2.4 cluster integration tests (W5.1 checks as package tests)**
  - Write: `packages/agent/test/cluster/{entity-boot,entity-crash,entity-admission,entity-passivation,sharding-config}.test.ts` (new), `packages/agent/test/helpers/{cluster-runtime.ts,cluster-crash-child.ts}` (new).
  - Deliverables: §4 checks 1–5 + R1/R2/R3 green, no sleeps (event-driven waits; bounded DB-row poll only where check2's pattern is already sanctioned).
  - Verify: `mise exec bun@1.4.1 -- bun test packages/agent/test/cluster --timeout 60000` twice consecutively. Stop: 2 consecutive full-green runs.

### Wave 3 — deletion + crash matrix (grep-zero achieved here)

- **L3.1 ledger plane deletion**
  - Write (delete/modify): `packages/ledger/src/storage/{storage.ts,initialize.ts,sqlite-l0-alarms.ts,sqlite-l0-inbox.ts,sqlite-schema-lifecycle.ts,migration-runner.ts,migration-statements.ts,decision-fact-migration.ts,u967-preflight.ts,u967-projection.ts,u969-preflight.ts,historical-projections.ts,historical-request-format.ts,sqlite-storage.ts,sqlite-l0-sessions.ts,sqlite-l0-write.ts,sqlite-l0-adapter.ts,sqlite-l0-rows.ts,sqlite-action-reads.ts,l0-action-builders.ts,l0-hash.ts}`, `packages/ledger/migration/` (whole dir), `packages/ledger/src/session/{kernel.ts,default-kernel.ts(D)}`, `packages/ledger/src/{layers.ts,services.ts,index.ts}`, `packages/ledger/bench/seed-turn-history.ts`, all ledger test D/M rows of §2, `packages/protocol/src/ledger/l0.ts`, `packages/protocol/src/storage/index.ts`.
  - Deletion symbols owned: `createAlarms`, `acquireLease`, `renewLease`, `LEASE_TTL_MS`, `HEARTBEAT_INTERVAL_MS` (ledger side), `migration-runner.ts`, `packages/ledger/migration/`, `u967-*`, `u969-*`, `historical-*`, `initialize`/`Storage.get`.
  - Verify: `mise exec bun@1.4.1 -- bun test packages/ledger packages/protocol && bun run check-types`. Stop: ledger/protocol green, grep of §5(a) returns zero under packages/ledger + packages/protocol.
- **L3.2 agent plane deletion + crash matrix port**
  - Write: `packages/agent/src/{session-handle.ts,session-controller.ts,session-turn.ts,session-requests.ts,session-configuration.ts,executor-retry-alarm.ts(D),session-admission.ts,session-request.ts,session-lifecycle/*,session-fold-commit.ts,session-record.ts,session-outbound.ts,session-stop-evidence.ts,session-parent-reply.ts,model-selection.ts,session-generations.ts,session-chat-runner.ts,session-message-observation.ts,compaction/successor.ts,layers.ts,bundle.ts,errors.ts}`, all packages/agent test M/D rows of §2 (incl. crash-matrix suite + helpers), `script/conformance/crash-matrix.json`.
  - Deletion symbols owned: `wakeSession`, `sweepSessions` (agent side), `LEASE_TTL_MS`/`HEARTBEAT_INTERVAL_MS`/`renewLease`/`acquireLease` consumers in agent, `executor-retry-alarm`.
  - Verify: `mise exec bun@1.4.1 -- bun test packages/agent --timeout 60000` (crash matrix must show 27+ cells green) `&& bun run check-types`. Stop: agent suite green, §5(a) grep zero under packages/agent.
- **L3.3 app plane deletion**
  - Write: `apps/openomni/src/composition/{alarm-worker.ts(D),alarm-sources.ts(D)}`, all apps/openomni test D/M rows of §2, `packages/channels/test/{helpers/requests.ts,owner-answer.test.ts}`, `apps/openomni/test/helpers/*`.
  - Deletion symbols owned: `alarm-worker.ts`, remaining `wakeSession`/`sweepSessions`/lease references in apps + channels tests.
  - Verify: `mise exec bun@1.4.1 -- bun test apps/openomni packages/channels && bun run check-types`. Stop: green + §5(a) grep zero under apps/ and packages/channels.
- **L3.4 script/CI deletion**
  - Write: the 10 script D rows of §2, `script/effect-service-contract.test.ts`, `script/request-authority-census.ts` (+ its conformance test), `package.json` (root, if any script names reference deletions), `.github/workflows/ci.yml`, `script/ci.ts`/`script/ci-plan.ts` lanes if they enumerate the files, `AGENTS.md` COMMANDS lines 185–186.
  - Verify: `mise exec bun@1.4.1 -- bun test script && bun run ci:plan && bun run lint:docs`. Stop: script suite + ci plan green, deleted names grep to zero repo-wide.

### Wave 4 — docs + full gates

- **L4.1 docs**
  - Write: `docs/kernel-contract.md`, `docs/implementation-status.md`, `docs/SLOP.md`, `docs/kernel-references.md`, `AGENTS.md` (stamp l.3, ledger ownership row l.225).
  - Verify: `bun run lint:docs`. Stop: doc-state sync law satisfied (stamp updated in the same PR).
- **L4.2 full gate chain + receipts**
  - Write: nothing (fix-forward only on gate failures, in the failing lane's files with that lane's author consulted; if trivial, this lane fixes).
  - Verify: the §5 checklist, in order, all exit 0; grep-zero receipts recorded in the PR body.
  - Stop: every §5 command exit 0, patch coverage 100% of changed lines.

Temporary adapters: exactly one — `packages/ledger/src/session/default-kernel.ts` (created L1.2, deleted L3.1). No other shims.

## 4. Test plan

New files and the exact events they await (no sleeps; bounded DB-row polls only in the two places check2/check3 already sanctioned — review F8):

| Test | Awaits / asserts |
|---|---|
| packages/agent/test/cluster/entity-boot.test.ts (check1) | Entity client `Prompt` reply resolves (success value = {ordinal, actionHash}); asserts 5 `cluster_*` tables in catalog, per-session file exists per sessionId, chain linked from `GENESIS_PREV_HASH`, second session writes its own file, `cluster_messages.processed=1` after reply. |
| packages/agent/test/cluster/entity-crash.test.ts (check2 + R3 + F12) | Child prints `APPENDED` marker (stdout subscription) → SIGKILL → assert exit 137, unprocessed mailbox row, chain intact; restart child → awaits `REDELIVERED deduped=true` marker with identical action_hash; **real turn/delivery action shapes** so `hydrateSessionHistory` returns non-empty history (F12); duplicate client send of the same messageId → exactly one chain row (R3); DeliverAt residual >= target (bounded DB-row wait). |
| packages/ledger/test/session/fence-rotation.test.ts (check3 + F5) | Two OS child processes on one session file: activation A rotates catalog fence N→N+1 (awaits child JSON line), holder commits; simulated old writer (fence N) refused `"stale"`; concurrent race → exactly one winner; restart rotates to N+2 and the N+1 writer is refused. |
| packages/agent/test/cluster/entity-admission.test.ts (check4) | Contract rows A01–A17 and B1–B8 as expected-decision tables against the exported `decideSessionAdmission`/`decideRequestTransition` (parity framing dropped per review F7); C1: 3 concurrent prompts to one entity → awaits all 3 replies, asserts ordinals 1,2,3 + non-overlapping handler spans + linear chain; A17 integration: interrupted session, backlog [prompt, resume] delivered as two envelopes → the resume is selected (whole-backlog drain, F4). |
| packages/agent/test/cluster/entity-passivation.test.ts (check "sleep/wake", F3+R1) | idle 500 ms config; awaits the activation finalizer event (Deferred resolved by a test hook in the entity layer / file-close observation) after last reply; sends next message → awaits reply (reactivation); schedules DeliverAt now+2000 ms before idling → awaits the timer's handled event after passivation (delivery reactivates, nothing stranded). |
| packages/agent/test/cluster/entity-timers.test.ts (F2) | RetryScheduled after attempt settled → reply is no-op, chain unchanged; Deadline after RequestResolve → request stays `resolved`, late token `duplicate`/`late_unknown` preserved; Deadline before resolve → terminal `expired`, later resolve `late_unknown`; WatchFired duplicate occurrence id → zero new chain rows. All awaited on entity replies + chain reads. |
| packages/agent/test/cluster/sharding-config.test.ts (R2) | Sets a conflicting `SHARDING_*` env var, builds the runtime, asserts the explicit config value won (reads effective ShardingConfig from context). |
| packages/ledger/test/storage/session-store.test.ts / catalog-store.test.ts | Fresh bootstrap table census (3 / 12 tables), busy_timeout-first open under a concurrent `BEGIN IMMEDIATE` holder (awaits child), `rotateFence` CAS: 2 concurrent rotations → fences {N+1, N+2}, no duplicates. |

Crash-fault matrix — 27 distinct faults (crash-matrix.json stays version 2, 27 rows; every row re-proven on the new plane; fault point stated as "cut at"):

| # | Fault (cut at) | Expected recovery on the entity plane |
|---|---|---|
| 1 | session_configure_commit_before_hibernate — configure gen-2 committed, cut before passivation | resumed_without_reexecution: activation replays nothing, snapshot gen 2, configureCalls 0 |
| 2 | turn_intent_before_llm_entry — turn intent committed, cut before model entry | resumed_without_reexecution: redelivered/open-turn resume seals the pre-minted resultId |
| 3 | llm_body_before_attempt_result_commit — model ran, cut before attempt result | lost: attempt `outcome_unknown`, no re-execution |
| 4 | fiber_exit_after_execute_before_action_commit — body done, fiber killed pre-commit | lost: `outcome_unknown`, receipt file proves single execution |
| 5 | llm_result_committed — cut right after llm result commit | resumed_without_reexecution |
| 6 | tool_wave_between_result_commits — 2 tools ran, cut after result 1 | lost (tool 2 `outcome_unknown`), tool 1 executed |
| 7 | retry_backoff_wait — retry.scheduled chain action committed + DeliverAt persisted, cut in the wait | rearmed: redelivered RetryScheduled wakes the entity, one model re-attempt, second delivery no-ops (replaces alarms.cancel CAS assert) |
| 8 | compaction_summary_before_result_commit | resumed_without_reexecution from durable boundary |
| 9 | inbox_admitted_before_turn_open — msg.received committed + acked, cut before turn open | rearmed: activation backlog drain (F4) admits it, one turn |
| 10 | outbound_reply_before_delivery_settle | rearmed: pending outbound redispatched once |
| 11 | recovery_dispatch_identity_committed_before_rpc (2-stage kill) | resumed_without_reexecution, resumeCount 1→2 |
| 12 | compaction_boundary_committed_before_publication | resumed_without_reexecution |
| 13 | delivery_ack_committed_before_owner_cleanup | resumed_without_reexecution, no second dispatch |
| 14 | platform_send_committed_before_local_ack_reconciled_sent | resumed_without_reexecution: reconcile against destination receipt |
| 15 | platform_attempt_marker_before_send_reconciled_not_sent | rearmed: one more physical attempt |
| 16 | platform_send_ambiguous_without_reconciliation | replayed: custody kept, external file shows 2 sends |
| 17 | compaction_concurrent_tail_committed_before_owner_crash | resumed_without_reexecution, tail message pending in chain fold |
| 18 | outbound_flood_deadline_before_timer_rearm | rearmed |
| 19 | watch_fired_committed_before_entity_wake (renamed from alarm_fire_committed_before_hibernated_doorbell) — occurrence chain action committed, cut before the entity processes the wake message | rearmed: redelivered WatchFired/backlog drain consumes the pending prompt exactly once, zero re-fire |
| 20 | owner_reclaimed_before_stale_transcript_flush — old fence writer flushes after rotation | lost: `commitSession` refuses `"stale"`, no partial row (fence-rotation form of the old lease reclaim) |
| 21 | compaction_summary_before_boundary_commit | not_durable |
| 22 | fold_checkpoint_committed_before_wake | resumed_without_reexecution (fresh process hydrates from seed, bounded range reads) |
| 23 | context_restore_checkpoint_committed_before_publish | resumed_without_reexecution |
| 24 | fold_checkpoint_tampered_before_load | rejected: `FoldCheckpointIntegrityError`, chain verify intact |
| 25 | same_id_result_after_checkpoint_before_wake | resumed_without_reexecution |
| 26 | open_tool_checkpoint_before_terminal | lost: `outcome_unknown`, write-once effect file untouched |
| 27 | captured_generation_missing_after_restart | rejected: `GenerationUnavailable` |

New-plane extras folded into the ported suite (not new matrix rows): kill between `BEGIN IMMEDIATE` and COMMIT inside `commitSession` (review R8 — asserts SQLite atomicity: no partial action row) added to the fence-rotation child; all children boot via `openSessionStore`/`openCatalogStore` (no `Storage.initialize`).

## 5. Grep-zero and gate checklist

(a) Deletion-symbol grep — must print nothing at merge:
```
grep -rln -E "LEASE_TTL_MS|HEARTBEAT_INTERVAL_MS|renewLease|acquireLease|sweepSessions|wakeSession|createAlarms" packages apps script --include=*.ts
grep -rln -E "alarm-worker|migration-runner|u967|u969|historical-projections|historical-request-format" packages apps script --include=*.ts
grep -rln -E "check-ledger-schema-drift|verify-ledger-rename|generate-ledger-archive-manifest|ledger-archive-snapshot|ledger-producer-manifest" packages apps script .github AGENTS.md package.json
test ! -d packages/ledger/migration
grep -rln "Storage.get()\|Storage.initialize" packages apps script --include=*.ts
```
(58 files hit the first grep today; §3 assigns every one via lanes L3.1/L3.2/L3.3 by directory.)

(b) Gate chain (run from repo root, `mise exec bun@1.4.1 -- ` prefix on every bun invocation), all exit 0:
```
bun install
bun run build
bun run check-types
bun run lint
bun run lint:tools
bun run lint:docs
bun run script/check-topology.ts
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run script/check-dead-exports.ts
bun run script/verify-tsconfig-inheritance.ts
bun run script/check-effect-boundaries.ts        # ratchet: sites/allowlist must not grow (224 entries)
bun test --coverage --timeout 60000
bun run script/check-patch-coverage.ts           # 100% of changed lines
bun run ci:plan
```
(c) Plane-specific receipts recorded in the PR: crash-matrix 27/27 green twice consecutively; `packages/agent/test/cluster` green twice consecutively; runner-site count unchanged (production runners only at `apps/openomni/src/cli/main.ts`, `apps/openomni/src/gateway.ts`).

## 6. Risks / decisions log

| # | Decision | Grounding |
|---|---|---|
| D1 | Entity in `packages/agent/src/cluster/`, composition in apps; **no new workspace package** | AGENTS.md ownership table (agent = generic session mechanics, l.128; app = product identity/routing, l.225); avoids review F11 topology churn |
| D2 | Handle-scoped storage as `openCatalogStore`/`openSessionStore`/`createSessionKernel`; singleton deleted; single TEMP `default-kernel.ts` bridges wave 1→3 | review F1 (initialize.ts:20–22, executor-retry-alarm.ts:19, history.ts); check2 finding 2 |
| D3 | Idempotency = chain-side key (`action.id = messageId/turnId/inputId`), not Envelope.primaryKey alone | check2 finding 1 (replay-after-crash still needs the chain key); crash-entity.ts `appendTurnIdempotent` |
| D4 | Pending admission set = chain fold (`msg.received` minus `inbox.deliver`), handler always evaluates the whole set; ack strictly after chain commit | review F4 + check4 F2/F4 (A17 non-prefix-invariance, ack-order crash loss); issue mapping "received message still committed as a chain action" |
| D5 | Timers: DeliverAt never cancelled; supersede = chain-guarded no-op; resolution tokens `duplicate`/`late_unknown` preserved | review F2; check2 finding 4 (deliver_at written once, "not before" never "exactly at"); check4 F7 |
| D6 | Fence rotation: catalog `session_index.fence` CAS +1 at entity activation; `commitSession` owner+fence check kept forever; expiry column/predicate deleted; `cluster_locks` never authorizes | review F5 + check3 findings 1–5; task directive "fence = catalog session.generation+1 via CAS"; sqlite-l0-write.ts:208–241 |
| D7 | Keep `leaseOwner`/`leaseFence` field names (fence vocabulary documented); grep-zero list is symbol-exact and does not name them | review §6 "lease plane last, fence never: KEEP lease_owner/lease_fence columns"; issue deletion list |
| D8 | Live retry keeps the in-process residual sleep; DeliverAt is the durable rearm (no-op if the live path won) | W1 receipt in implementation-status.md l.58 (persist-before-wait, residual sleep); review F2 |
| D9 | ShardingConfig pinned fully explicit in prod and tests; R2 test proves override beats `SHARDING_*` env | review R2 / check1 finding 5 |
| D10 | Passivation bounds file handles: store opened in activation scope, finalizer closes; R1 test proves DeliverAt across idle | review F3/R1/R5; session-entity.ts:33 (spike finalizer) |
| D11 | Fresh schema: 3 session-file tables + 12 catalog tables; `fold.checkpoint`/`outbound`/`inbox.deliver` stay action kinds (0041 proves the kind-constraint shape); no migration of old files, `OPENOMNI_DB_PATH` ignored | issue "Fresh schema target ≈15 tables"; migration 0041 SQL; issue "old catalog.db not read/migrated/deleted" |
| D12 | New config `catalogPath` (~/.openomni/catalog.sqlite) + `sessionsDir` (~/.openomni/sessions); old storage.db inert on disk | issue deletion rules; config.ts:309 current default |
| D13 | Cluster imports use `effect/cluster` / `effect/workflow` (rc.118 real paths, not `effect/unstable/cluster`); kernel-references.md corrected in this PR | node_modules/effect/src/cluster/*.ts; review R6; task rc.118 facts |
| D14 | New tests run effects only through existing allowlisted helpers (`runAgent`, `isolated`, apps `effect.ts` helpers); ratchet may shrink, never grow | script/conformance/effect-runner-sites.json (224 entries); AGENTS.md boundary law |
| D15 | Crash matrix stays exactly 27 rows; 2 rows renamed/re-grounded (`watch_fired_committed_before_entity_wake`, fence-rotation form of `owner_reclaimed_...`), zero rows dropped | script/conformance/crash-matrix.json (version 2, 27 rows measured); issue acceptance ">= 27 distinct crash faults" |
| D16 | `decideSessionAdmission`/`decideRequestTransition` semantics untouched — only exported and re-fed; contract tables A01–A17/B1–B8 pinned as expected-decision rows (parity framing dropped) | review F6/F7; check4 tables |
| D17 | monitor tool re-expressed over watch-sources + DeliverAt; occurrence identity `Alarm.occurrenceId(alarmId, epoch, sourceKey)` and budget stay chain-decided | issue "monitor.ts re-express over DeliverAt/DurableDeferred"; #971 receipt (implementation-status.md l.175) |
| D18 | Risk: `cluster_messages`/`cluster_replies` unbounded growth (R4) — out of W5.2 scope; recorded as a follow-up note in implementation-status.md with the measured row-growth expectation, no sweeper built | review R4; scope discipline (issue names no sweeper) |
| D19 | Risk: session-handle.test.ts (2,614) + session-lifecycle-conformance (1,756) are the heaviest ports; they sit alone in L3.2's scope with the crash matrix to keep one author over the whole agent plane | wc -l this session; lane-disjointness rule |
| D20 | Wave 2 keeps old planes alive in parallel with the entity plane so every wave ends green; deletion only in wave 3 after the crash matrix is green on the new plane | review §5 cut order (delete only when green); task "foundation wave must leave build+tests green" |
