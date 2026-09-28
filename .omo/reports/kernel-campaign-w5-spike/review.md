# W5.1 cluster spike — adversarial review & W5.2 go/no-go

Reviewer: omo-native-code-reviewer (task st_01a0e80a), 2026-09-28.
Worktree: /Users/ino/Develop/openomni-w51, branch kernel/1196-cluster-spike-20260928, HEAD a6e6bc4c, base main 5b925d12.
Independent verification this session (not trusting prior receipts): `bun test --timeout 60000` -> **37 pass / 0 fail, 159 expect(), exit 0** (residual_ms=1510); `tsc --noEmit` -> exit 0; `ultracite check spike/` -> **exit 0, 0 errors** (the 2 errors verify.md flagged were fixed in a6e6bc4c); `git diff 5b925d12 -- packages/ apps/ script/` -> empty.

Skill-perspective check: tool-based skill loading is unavailable in this session; the documented criteria of `remove-ai-slops` (tautological/mirroring/deletion-only tests, needless parsing) and `programming` (brittle tests, untyped escape hatches, needless abstraction/validation) were applied from the prompt. Result: **no HIGH violation of either skill perspective**; two MEDIUM/LOW slop findings recorded (F7, F8). Zero `any`/`unknown` in spike code (one English "any" in a comment); zod parsing appears only at real process boundaries (argv, child-process JSON) — compliant.

## 1. Verdict

**GO-WITH-CONDITIONS**

The spike proves everything W5.2's architecture actually depends on cluster for: SingleRunner boots on sqlite (5 cluster_* tables), persisted RPCs survive SIGKILL and redeliver (exit 137, `processed=0` row survives, redelivery ~200ms after reboot), OUR chain dedupes at-least-once redelivery (same 64-hex action_hash, no duplicate row), DeliverAt is a durable "not-before" clock (residual 1507–1604ms across 7 observed runs against a 1500ms target, poll-granular), the commit fence refuses a second OS-process writer with `"stale"` while cluster_locks provably is NOT a fence, admission/request decisions are plane-independent (17/17 + 8/8), and the entity mailbox is a genuine single writer (non-overlapping handler spans, linear chain under concurrency 3). What blocks an unconditional GO is not cluster — it is OUR code: the process-global `Storage.get()`/`initialize()` singleton is structurally incompatible with per-session files (the spike could only hydrate by re-initializing the global to one file per process), DeliverAt has no tested cancellation story to replace `settle()` on the alarm plane, entity passivation/wake (the headline "sleep/wake" mechanism) was configured but never exercised, and fence rotation across runner generations was never driven by the cluster lifecycle. These are closable with bounded work and are ordered in section 5; none contradicts the design.

## 2. Numbers

| Check | What it measured | Numbers (receipt + my re-run) |
|---|---|---|
| check1 boot/storage | SingleRunner boots on sqlite; persisted prompt -> our chain; per-session files | 4 tests / 20 asserts; 5 cluster_* tables; chain s1: 2 rows linked from GENESIS, s2: 1 row own file; processed>=1 in cluster_messages |
| check2 crash | SIGKILL mid-turn, redelivery, dedupe, checkpoint, DeliverAt | exit=137; 1 unprocessed mailbox row survives kill; REDELIVERED deduped=true identical action_hash; CHAIN_OK 1 -> 3 (recomputed hashes); CHECKPOINT_HYDRATED rev=2 nonCheckpointActions=0; residual_ms 1513/1517/1604 (receipt), 1507/1514/1517 (verify), 1510 (this review) — all in [1500, 3500) |
| check3 fence | Two OS processes vs OUR commit fence + raw SQLITE_BUSY | 5 tests / 20 asserts; holder commits rev 1..4; foreign writer refused `"stale"` every time incl. a concurrent race (exactly 1 winner); SQLITE_BUSY after 5128/5134ms vs busy_timeout 5000 |
| check4 admission | Mailbox plane == inbox plane on the pure W1 contract; single-writer FIFO on real runtime | 27 tests / 98 asserts; Table A 17/17, Table B 8/8; C1 spans ordered 1,2,3 with start(n) >= end(n-1); chain linear under concurrency 3 |
| check5 boundaries | Effect boundary law untouched | checker 233/233 allowlisted, exit 0, identical to main; allowlist byte-identical to base; spike runner sites now 11 (5 src / 6 test — check5's "5" is stale); ultracite 0 errors at HEAD |
| suite | repeatability | 4 consecutive full green runs observed across sessions (3 in verify.md + 1 here), 8.5–8.7s each; spike total ~2030 LOC (check4 test grew to 720 lines post-verify) |

## 3. Findings

Severity legend: blocking = must be resolved inside W5.2 before old planes are deleted (maps to HIGH); major = MEDIUM; minor = LOW. **CRITICAL: none. HIGH within the spike-as-delivered: none** — all blocking items are W5.2-transfer gaps, not spike defects.

- **F1 (blocking / HIGH-for-W5.2): process-global storage singleton.** `initialize()` throws on a second dbPath (packages/ledger/src/storage/initialize.ts:20–22) and `hydrateSessionHistory`, `commitFoldBatch`, and `createRetryAlarmPort` all read the global (`Storage.get().alarms`, packages/agent/src/executor-retry-alarm.ts:19; SessionHandleStore throughout packages/agent/src/session-lifecycle/history.ts). The spike's check2 only worked by `initialize({dbPath: sessionFile})` once per child process (spike/w5-cluster/src/crash-child.ts:157). Consequence: W5.2 per-session files require a handle-scoped SessionHandleStore/Storage (or an explicit one-process-per-session decision) BEFORE any plane deletion; this is the single largest untransferred risk.
- **F2 (major): no cancellation for DeliverAt messages.** The alarm plane W5.2 deletes has `settle(id)` (executor-retry-alarm.ts:41–46, cancels superseded retry/deadline alarms). A persisted DeliverAt message (crash-entity.ts:49–58) has no tested cancel/delete; check2 finding 4 shows `deliver_at` is written once at saveRequest. Consequence: deadline/watch/retry supersede semantics must become idempotent no-op checks inside the handler (chain-side state decides), or a storage-level delete must be proven.
- **F3 (major): passivation/wake never exercised.** `entityMaxIdleTime` is configured (spike/w5-cluster/src/runtime.ts:24: 2s) and the finalizer closes the db (session-entity.ts:33), but no test waits past idle and asserts close -> reactivation on the next message. "entityMaxIdleTime = sleep/wake" is a headline #1197 claim resting on config, not evidence.
- **F4 (major): whole-backlog drain requirement.** `decideSessionAdmission` in interrupted state scans the entire pending list (packages/agent/src/session-admission.ts:66–70; proven non-prefix-invariant by A17, spike/w5-cluster/test/check4-admission.test.ts:~330). The spike proved parity on synthetic arrays only — no cluster entity ever drained a real MessageStorage backlog as a batch. Consequence: the W5.2 handler must peek all unprocessed messages per entity before deciding; a one-envelope-at-a-time handler silently diverges from W1.
- **F5 (major): fence rotation untested under the cluster lifecycle.** The spike pins owner/fence/expiry to constants (session-entity.ts:12–13, session-file.ts:17: expiry 2100-01-01); crash/restart reuses the same identity. check3 proves the fence refuses a *foreign* owner, but nothing drives "new runner generation acquires fence N+1, old writer refused" from Sharding events. Consequence: deleting the lease *acquisition* plane must not delete the fence columns or the commitSession authorization check (check3 finding 3–5: cluster_locks carries no fence, no CAS); W5.2 must define who increments the fence on takeover.
- **F6 (major): every load-bearing import is spike-only plumbing.** Deep source imports (session-file.ts:9–14, admission-bridge.ts:7–10, crash-child.ts:19–22) plus the bunfig virtual-module shim (bunfig.toml, test/preload-module-map.ts) exist because `@openomni/ledger` exports only `"."` and agent's pure decision modules are unexported. Consequence: W5.2 first PR must export `decideSessionAdmission`/`decideRequestTransition` and a narrow l0 write-kernel surface (commitSession + hash constants), or the real implementation inherits tsconfig-paths resolution as a durable-path dependency (check2 finding 5).
- **F7 (minor, remove-ai-slops MEDIUM): parity assertions are partially tautological.** Table A/B "parity" feeds the SAME pure function two structurally identical row arrays built by adjacent mappers (check4-admission.test.ts `inboxRows` vs admission-bridge `mailboxToPending`), and `foldInboxOrder`'s "shuffle" (reverse().sort by ordinal, check4-admission.test.ts:~498) cannot fail. Parity holds by construction; the real value is the expected-contract column (A01–A17 kinds, B1–B8 resolution tokens) and the C1/C2 integration runs, which are genuine. Keep the contract rows in W5.2's port; drop the parity framing.
- **F8 (minor / LOW): small test slop.** check1 test c asserts `>= 1` immediately after `waitForDbRow` already established it (check1-boot.test.ts:88–89) — redundant. check1's `waitForDbRow` and fence-child's `openWithBusyRetry` (fence-child.ts:47–58) are bounded polls; both fall under the sanctioned "await a DB row" / "clock under test" allowances, not violations.
- **F9 (minor): ledger open-time busy hazard is a real product bug surfaced by the spike.** Bootstrap runs a schema preflight BEFORE `PRAGMA busy_timeout` (check3 notes), so concurrent opens fail instantly with SQLITE_BUSY_RECOVERY. W5.2 multi-process opens need pragma-before-preflight in the ledger bootstrap.
- **F10 (minor): receipt numeric staleness.** check5's runner-site count (5 -> 11) and verify.md's ultracite state (2 errors -> 0 at HEAD a6e6bc4c) and check4 LOC (489 -> 720) are stale snapshots. No PASS/FAIL verdict is flipped; verify.md itself honestly flagged most of this. Current truth is the numbers table above.
- **F11 (minor, scope): branch touches root package.json (+`"spike/*"` workspaces) and bun.lock**, outside the literal spike/+reports/ write fence (documented in check5 §7, required for workspace deps), and the spike workspace makes check-deps + all 6 check-topology lanes exit 1 on this branch. Acceptable for a never-merged spike; W5.2 must register real packages in the topology inventory (check5 finding 3).
- **F12 (major): fold/hydration evidence is mechanical only.** `history=0` throughout check2 — spike `kind:"prompt"` actions do not project through `SessionHandleStore.delivery()` (check2 finding 3). Checkpoint commit + seed-consumption is proven; real turn/delivery/request action shapes producing non-empty history is not.

## 4. Risks the spike did NOT test, and the cheapest closure

| # | Risk | Cheapest closure |
|---|---|---|
| R1 | Entity idle/wake with an in-flight DeliverAt (scheduled beyond the idle window: does passivation strand it? does delivery reactivate?) | One test: idle 500ms, DeliverAt now+2000ms, assert finalizer log then reactivation handles the message (closes F3 too) |
| R2 | `SingleRunner.layer` applies overrides over `ShardingConfig.layerFromEnv` — ambient `SHARDING_*` env can leak into prod/test (check1 finding 5) | One test with a conflicting env var asserting the explicit override wins; in prod pin a full config layer, never env |
| R3 | Message dedup keys: duplicate client sends (caller retry) — two cluster_messages rows? `Envelope.primaryKey` semantics unproven | Send the same turnId twice from the client; count cluster_messages + chain rows; read Envelope.ts primaryKey docs (30 min) |
| R4 | SqlMessageStorage growth/cleanup: cluster_messages/cluster_replies grow forever; no prune observed | Read SqlMessageStorage source for a cleanup API; else measure rows after 1k prompts and spec a sweeper on `processed=1` age |
| R5 | SQLite file-handle limits at 10^4 sessions (one open db per active entity) | Loop 2k entityIds with idle 200ms, watch `lsof -p` peak — confirms the passivation finalizer bounds handles |
| R6 | Effect rc churn: everything is pinned to 4.0.0-rc.118 export paths (`effect/cluster`, not `effect/unstable/cluster` as the docs said) | Exact-pin the rc; keep this spike suite alive as a canary that must go green on any rc bump before W5.2 rebases |
| R7 | DeliverAt precision under backlog (residual measured on an idle runner only; poll gate is 100ms-granular) | Schedule 100 messages in one run; assert none fires early; record p95 lateness |
| R8 | Crash *inside* the commit transaction (kill between BEGIN IMMEDIATE and COMMIT) — SQLite atomicity assumed, not observed | Fold into the W5.2 crash-matrix port (packages/agent/test/helpers/crash-matrix.ts already models kill points) |

## 5. Recommended W5.2 cut order

1. **Surface PR (no behavior):** export `decideSessionAdmission`, `decideRequestTransition`, and a narrow l0 write-kernel (`commitSession`, hash constants) from package indexes; fix busy_timeout-before-preflight (F6, F9). Deletes nothing.
2. **Handle-scoped storage:** kill the `Storage.get()`/`initialize()` one-dbPath singleton (or explicitly commit to one-process-per-session and document it). Biggest risk, so it goes before any entity code; existing ledger/agent tests are the safety net (F1).
3. **Session entity + per-session files + catalog:** the check1/check4 shape with REAL turn/delivery/request action shapes (non-empty history, F12), whole-backlog drain (F4), ack-after-chain-commit ordering (check4 F2), fence acquisition wired to runner lifecycle (F5). Add the R1/R2/R3 tests here.
4. **Inbox plane -> mailbox:** port the crash matrix onto the entity; when green, delete inbox tables and paths. The inbox `status/consumed_by/ordinal` columns have exact cluster equivalents (check4 F1/F5); `kind/content/origin` ride inside the Rpc payload.
5. **Alarm plane -> DeliverAt/DurableClock:** only after F2 (cancellation/supersede) is answered; port retry.scheduled (`notBefore` == DeliverAt, treat as "not before" never "exactly at"), then deadline/watch; delete alarms table.
6. **Lease plane last, fence never:** delete acquisition/renewal machinery; KEEP lease_owner/lease_fence columns and the commitSession authorization — cluster_locks routes traffic, it does not authorize writes (check3 findings 1–5).
7. **Migration plane:** fresh schema from day one per #1197; delete the migration runner when the last old-plane consumer is gone. Register the new package in the topology inventory in the same PR (F11).

## 6. Ready-to-post GitHub comment (issue #1113)

```markdown
**W5.1 cluster spike review: GO-WITH-CONDITIONS for W5.2 (#1197).** Spike: PR #1238 (placeholder).

Independently re-verified on branch `kernel/1196-cluster-spike-20260928` (HEAD a6e6bc4c, effect 4.0.0-rc.118):
`bun test` 37 pass / 0 fail / 159 asserts, 4 consecutive green runs; `tsc` and `ultracite` clean;
boundary checker 233/233 allowlisted, allowlist byte-identical to main.

**Proven** (cluster = host + mailbox + clock; durability stays ours):
- SingleRunner boots on sqlite; persisted RPCs land in `cluster_messages` (5 cluster_* tables)
- SIGKILL mid-turn (exit 137): unacked message survives, redelivers on reboot; OUR chain dedupes
  the replay (identical action_hash, no duplicate row); recomputed hash chain intact (CHAIN_OK 3)
- DeliverAt = durable not-before clock: residual 1507–1604 ms across 7 runs vs 1500 ms target
  (poll-granular, 100 ms) — fits `retry.scheduled.notBefore`
- Commit fence beats a second OS process: refused `"stale"` incl. a concurrent race (1 winner);
  `cluster_locks` carries no fence/CAS — it routes traffic, it must never authorize writes
- Mailbox is a real single writer: 3 concurrent prompts -> non-overlapping handler spans, ordinals 1,2,3
- Admission/request contracts are plane-independent: 17/17 + 8/8 decision rows match W1

**Conditions before deleting the old planes:**
1. Handle-scoped storage: `Storage.get()`/`initialize()` is process-global one-dbPath — structurally
   incompatible with per-session files; rework first (biggest risk, spike only worked around it)
2. DeliverAt cancellation/supersede story to replace alarm `settle()` (deadline/watch)
3. Passivation/wake (entityMaxIdleTime) actually exercised, incl. in-flight DeliverAt across idle
4. Fence rotation driven by runner lifecycle; keep fence columns + commitSession check forever
5. Export the pure decision modules + l0 write-kernel (spike runs on deep-import shims today)

Cut order: surface exports -> handle-scoped storage -> Session entity + per-session files ->
inbox->mailbox (delete) -> alarms->DeliverAt (delete) -> lease machinery (delete, fence stays) ->
fresh schema, no migration plane. Full review: `.omo/reports/kernel-campaign-w5-spike/review.md`.
```
