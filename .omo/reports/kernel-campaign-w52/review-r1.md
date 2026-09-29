# VERDICT: GO-WITH-CONDITIONS

W5.2 #1197 / PR #1239, branch `kernel/1197-session-entity-20260928` HEAD `7f0e7046` vs `origin/main` `5b925d12`.
Reviewer: adversarial pass, read-only. All commands below were run by the reviewer in this worktree, not taken from receipts.

Skill-perspective check: the `remove-ai-slops` and `programming` skills were **not loadable** in this session (no skill-loading tool available); their documented criteria were applied manually to every new/changed test and production file inspected. Result: **no violation of either skill perspective found** — the "coverage" lane tests assert durable behavior (self-heal into the catalog, stale-fence yield, approval facade wiring), not line execution or implementation constants; no deletion-only or tautological tests; the JSON.parse/Zod parsing in the entity handlers sits at a genuine wire boundary (cluster RPC payloads).

## Reviewer-run verification

| check | command | result |
| --- | --- | --- |
| grep-zero (B) | `rg -l <token>` for all 12 tokens: `LEASE_TTL_MS`, `HEARTBEAT_INTERVAL_MS`, `renewLease`, `acquireLease`, `sweepSessions`, `wakeSession`, `createAlarms`, `alarm-worker`, `migration-runner`, `u967-`, `u969-`, `historical-` (excl. `.omo`, `*.md`) | **0 hits each**; `packages/ledger/migration/` does not exist |
| protocol wire visibility (C) | `git grep -c -E 'AcquireLease\|RenewLease\|LeaseResult\|Alarm\.(Arm\|Fire\|RequestDeadline)\|InboxAdmission' origin/main -- apps/desktop packages/channels packages/ui` | **exit 1 (zero matches)** — the deleted l0.ts/storage schemas are storage-internal; no wire/DTO shape consumed by desktop or channels changed |
| ratchets (C) | `bun script/check-effect-boundaries.ts` | exit 0; `script/conformance/effect-runner-sites.json` diff is **+12/−188** (allowlist shrank, no growth) |
| deps (C) | `bun script/check-deps.ts` | exit 0 ("no violations, 4 stale docs" — stale notices pre-existing) |
| types | `bun run check-types` | 17/17 successful |
| new cluster/store tests | `bun test packages/agent/test/cluster packages/ledger/test/storage/{catalog-store,session-store}.test.ts packages/ledger/test/session/fence-rotation.test.ts` | **61 pass / 0 fail** (232 asserts) |
| new app tests | `bun test apps/openomni/test/{cluster-runtime,message-session,monitor-ports,watch-sources,index-coverage}.test.ts` | **20 pass / 0 fail** (65 asserts) |
| escape hatches (F) | `rg ': any\b|as any\b|as unknown as'` over all changed prod `.ts` | 0 new sites |

## Axis results

- **A. Durable core — PASS** with findings 1–3 below.
  - F5 fence rotation: `CatalogStore.rotateFence` is a single `UPDATE ... SET fence = fence + 1 RETURNING` under BEGIN IMMEDIATE (catalog-store.ts:107-116); file adoption is a strictly-newer CAS (`sqlite-l0-sessions.ts:64-78`, idempotent for the current owner+fence pair, refuses `>=`); `commitSession` re-checks owner+fence+revision in one guarded UPDATE (sqlite-l0-write.ts:139-149). No fence steal path found: the `localInboxCommit` borrow (process-entry.ts:110-119) borrows the *current* row authority and is still revision-CAS-guarded — an interleaved rotation refuses the commit typed (`ForeignFailure`), fail-closed. Covered by `fence-rotation.test.ts` and `session-entity-coverage.test.ts` ("stale activation yields", fence 2→3 asserted).
  - F4 admission/drain: activation drains the whole backlog before the mailbox opens (session-entity.ts:349) and after every receive; `appendReceived` dedupes redelivery on the chain action id. Integration test drives 3 concurrent prompts through the real SingleRunner and asserts non-overlapping handler spans + linear verified chain (entity-admission.test.ts:582-622).
  - F2 DeliverAt: no cancellation-in-storage anywhere; supersede is delivery-time chain guards (`retryDelivery`/`deadlineDelivery`/`watchFiredDelivery`/`watchTimeoutDelivery`, timers.ts) with `arm` committing chain evidence strictly before the persisted rearm (timers.ts:162-176). Exercised by entity-timers tests.
  - F3 passivation/wake: entity-passivation.test.ts asserts file closed by the passivation finalizer (event-polled `waitUntil`, not sleeps) and a DeliverAt beyond the idle window reactivating.
  - F1 handle-scoped storage: `Storage.get()`/`initialize()` process plane deleted (`storage.ts`, `initialize.ts`, `sqlite-storage.ts` all removed); kernel is a factory over explicit store handles (session/kernel.ts:createSessionKernel); the app plane is built at the composition root and threaded (cluster-runtime.ts:createAppLedger). One residual singleton remains — finding 3.
  - F6 exports: `decideSessionAdmission`/`decideRequestTransition`/`requestAuthorityKernel` exported from `@openomni/agent` (src/index.ts:4-5), `SessionHandleStore` from `@openomni/ledger`; zero deep imports (`rg 'from "@openomni/(ledger|agent)/(src|dist)'` = 0).
- **B. Deletion grep-zero — PASS** (table above).
- **C. Owner stop conditions — PASS.** No wire/DTO change visible to desktop/channels (confirmed against main, command above). No ratchet grew: effect-runner-sites shrank; the check-deps growth is 6 *factory* names beside the 7 pre-existing surface names for the same 7 perimeter surfaces (check-deps.ts:536-551) — channels does not open storage; it wraps composition-injected sub-adapters (`ChannelStoreSource`, channels/src/router/stores.ts:21-44). Same boundary, handle-scoped form. See finding 5 (NIT).
- **D. Test quality — PASS.** The single `Effect.sleep(40)` in entity-admission.test.ts:590 is a measured workload widening the overlap-detection window, not synchronization — legitimate. Failure paths assert typed errors (`LeaseRefused`, `MonitorRefused`, `ExecutionApprovalError`). SIGKILL crash test kills a real child process and asserts unacked-envelope survival + chain dedupe by identical action_hash (entity-crash.test.ts:41-98). Wave-4 coverage tests assert behavior, not lines. Deleted alarm/lease/migration/monitor suites are replaced on the entity plane (entity-* suites, fence-rotation, catalog-store, session-store, monitor-ports, watch-sources); monitor budget (`notificationLimit`) is asserted in monitor-ports.test.ts; no deleted *behavior* that survives in production was found without an equivalent test.
- **E. Docs sync — PASS.** implementation-status.md carries the W5.2 receipt (line 3-5, marked pending merge); SLOP.md B4 row closed referencing this PR (line 59); kernel-references.md fixed to `effect/cluster` rc.118 (line 15) per the W5.1 note; kernel-contract/session-lifecycle updated.
- **F. Quality DoD — PASS** with finding 3 (dead registry). No new any/unknown; no duplicated old path (the lease/alarm/inbox/migration planes are actually gone, not shadowed); check-dead-exports green per receipt (the registry below escapes it because `lookup` is a property, not an export).

## Findings

1. **SHOULD-FIX (MEDIUM)** — `packages/agent/src/cluster/session-entity.ts:195-212` (`detachTurn`): the continuation re-drain is `Effect.andThen(...drain)` after `Effect.onError(log)`, so on a **non-interrupt detached-body failure the drain never runs**. Backlog appended during the failed turn (senders already acked) stays pending until the next external stimulus — for a non-fence failure (e.g. `StorageUnavailable`) the same activation keeps authority and nothing wakes it; the code comment only covers the stale-fence case. Why it matters: an admitted prompt can stall indefinitely on an otherwise healthy session. Minimal fix: run the re-drain on exit rather than success (`Effect.onExit` / sequence the drain in an `ensuring` guarded against interrupt), or die the activation on non-interrupt failure so the cluster redelivers.
2. **SHOULD-FIX (MEDIUM)** — `session-entity.ts:118-155` (`appendReceived`) and `:262-315` (`requestCommand`), also `apps/openomni/src/index.ts:741-768` (`facade.interrupt` during `stop()`): row/revision is read, then committed on a later Effect step while a detached turn commits concurrently on the same handle; a lost race surfaces as `LeaseRefused reason:"revision"` → `Effect.orDie` → handler defect (mailbox path recovers only via cluster redelivery + chain dedupe; the stop() path fails shutdown loud and resets `stopping`). Not a lost write (revision CAS holds) and the C1 concurrency test passed, but the benign race is escalated to a defect instead of one bounded retry. Minimal fix: retry once on `reason:"revision"` at these three call sites.
3. **SHOULD-FIX (MEDIUM, dead code / F1 residue)** — `packages/agent/src/cluster/kernel-registry.ts:41` `sessionKernels` is a module-level process singleton whose `lookup` has **zero readers** anywhere (prod, tests, exports — reviewer-grepped); only `register` is called (session-entity.ts:347). Its own doc says it "dies with the handle plane (wave 3)", and wave 3 shipped in this PR. Why it matters: a write-only global map contradicting the PR's F1 posture and holding kernel references for live activations. Minimal fix: delete the registry and the register/finalizer pair in the activation.
4. **NIT** — `session-entity.ts:169` / `consumePending`: `deliveryActions(items, "noop", ...)` persists the sentinel string `"noop"` as a `turnId` in durable chain rows. Works (the pending fold only checks reference existence), but a durable magic string deserves a named constant + one line in kernel-contract.
5. **NIT** — `script/check-deps.ts:536-551`: the +6 factory names are a justified handle-scoped rename of the same 7 surfaces, but applying the factories at the composition root (passing built `ChannelStores` into channels) would have avoided any allowlist edit at all. Consider for a later slim.
6. **NIT** — `packages/agent/test/cluster/entity-passivation.test.ts:65-67` depends on the cluster's internal ~5s reaper resolution (documented in-test). If a future effect rc changes the reaper floor the test's timing envelope breaks. Acceptable now; pin a comment to the rc version (done) and revisit on upgrade.

Severity mapping for the wrapper: CRITICAL — none. HIGH — none. MEDIUM — findings 1, 2, 3. LOW — findings 4, 5, 6.

## Brief-item adjudication (8 pre-identified)

1. check-deps growth: **confirmed benign** (finding 5, NIT). 2. `localInboxCommit` borrow: **not a fence steal** — revision-CAS guarded, refusal typed, fail-closed (axis A). 3. settle/detach/runTurn/stop(): **sound overall**; residual races are findings 1–2. 4. Detached-body loud logging: logging is acceptable as the terminal for stale-fence causes, but the skipped re-drain behind it is finding 1. 5. Deleted tests: **equivalents exist** on the entity plane (axis D). 6. Protocol vocabulary retention: confirmed intentional; the 16 pre-existing `unknown` sites are carried to #1113, not new. 7. Nits: absorbed into findings 4–6; ConfigProvider/readUntil/ForeignFailure double-wrap items are pre-existing or cosmetic, none load-bearing. 8. Owner stop conditions: **held** (axis C, reviewer-run).

## Conditions

GO, conditioned on landing findings 1–3 (small, localized) either pre-merge or as an immediate follow-up commit on this branch. None is a correctness regression against the deleted planes — the old lease/alarm plane had strictly worse variants of each — so they do not block the cutover itself.

## Disposition (parent, after fixes)

- Finding 1 (re-drain skipped on detached-body failure): landed in 0f41eaf0 — `detachTurn` re-drains on `Effect.onExit` unless the exit is interrupt-only or a lease/fence loss (`LeaseLost`, `LeaseRefused stale`, `CommitRefused fence`).
- Finding 2 (revision race escalated to defect): landed in 0f41eaf0 — one bounded re-read on `CommitRefused reason:"revision"` at `appendReceived`, `requestCommand`, and `facade.interrupt` (`retryRevision`).
- Finding 3 (dead `sessionKernels` registry): landed in 0f41eaf0 — `kernel-registry.ts` register/finalizer pair deleted; the `SessionKernel` type remains as a consumed import.
- Finding 4 (`"noop"` turnId sentinel): pre-existing on main (`session-admission.ts`), not introduced here; carried to #1113 with the other agent-plane nits.
- Findings 5-6: recorded, no change.
- Parent verification of the fix commit: root check-types 0, lint 0 warnings, boundaries exit 0, dead-exports 0 violations, import cycles 0, agent cluster + app e2e/index-coverage 74/0, run-agent-loop/durable-reconstruction/lifecycle/request-controller/cluster-runtime 20/0.
