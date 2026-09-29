# PR #1240 adversarial review, round 3

**Verdict: GO-WITH-CONDITIONS.**
**Findings: 0 CRITICAL, 0 HIGH, 3 MEDIUM, 1 LOW. No Owner STOP.**

Reviewed at HEAD `759140627e0bf81a28643f47cb593b12310e31a0` (branch
`kernel/1113-w5-closure-20260929`, worktree `/Users/ino/Develop/openomni-w53`)
against base `origin/main` = `8390912c`. Fresh reviewer; read
`review-r3-brief.md`, `review-r2.md`, `owner-decisions.md`, the six
F?-r2 briefs/receipts, and `B-verify.md`, then re-verified everything below
directly on the tree. Nothing was committed; no mutation campaign was run;
script lanes ran strictly serially.

Skill-perspective check: the `remove-ai-slops` and `programming` skills were
not available as loadable tools in this session; their documented criteria
were applied manually to every changed test and production file (see
"Slop/overfit pass" below). The diff does not violate either perspective.

## 1. Every r2 finding re-verified on the current tree

### r2 finding 1 (Owner STOP — receipt frame) — FIXED, Owner decision honored
- `git diff 8390912c -- packages/channels/src/websocket.ts` (exit 0): the
  accepted receipt is emitted as exactly
  `{"type":"receipt","status":"accepted"}`; the admission travels in the new
  additive `session_bound` frame (`SessionRead.Bound`,
  `packages/protocol/src/gateway/session-read.ts:71-75`), matching
  `owner-decisions.md` ("Move to additive frame (default)").
- Grep `receipt\.result\b` across the repo: **0 matches** (the two
  `receipt.resultCode` hits in
  `packages/channels/test/router/messaging/existing-agent-message-driver.test.ts`
  are a pre-existing different symbol).
- Executed the production `WebSocketHandler.handleFrame` with an executed
  admission (bun -e probe, exit 0). Observed wire bytes, in order:
  `{"type":"receipt","status":"accepted"}` then
  `{"type":"session_bound","result":{...}}` — the receipt is byte-identical
  to base shape. `packages/channels/test/websocket.test.ts:171` and
  `apps/openomni/test/session-cursor.test.ts:118` assert the same order and
  shape; both passed in this session's runs.
- Counterexample attempt: see MEDIUM finding M1 below (reconnect edge where
  the receipt is misrouted/dropped). It does not change the frame's shape.

### r2 finding 2 (baseline vs candidate compiler disagreement) — FIXED
`script/quality-mutation-input.ts:71-80` introduces one shared ownership rule
(`projectRootPaths` + `ownsDiagnostic`); `script/quality-mutation-compiler.ts:121-128`
(candidate/frozen path) and `script/run-quality-mutations.ts:781-791`
(baseline path) both consume it. The extended regression
(`script/run-quality-mutations-compiler.test.ts:424-...`) now drives the
r2 counterexample through the candidate compiler: unchanged original bytes of
the transitive `b/value.ts` are **valid**, a genuinely invalid mutation is
**invalid**, and an error attributed to consumer root `a/index.ts` is
preserved. Passed in scripts-tooling-2 (exit 0).

### r2 finding 3 (audit cannot read version-1 summary) — FIXED
`script/quality-audit-issues.ts:14-22`: `previousTotalsSchema =
totalsSchema.partial({cyclomatic, halstead, crap})` decodes history only;
current-output validation stays full. `regressions` skips unmeasured
dimensions (no invented zeros, no reset). The regression pins the **actual
issue #1119 footer bytes** (`quality-audit-issues.test.ts:152-192`) and
asserts: legacy footer decodes, absent dimensions produce no regression row,
and a version-1 dimension regression still fires. Passed in
scripts-tooling-1 (exit 0).

### r2 finding 4 (lost overlapping read waiters) — FIXED
`apps/desktop/src/renderer/chat/gateway-transport.ts:124-131,238-256`: reads
carry a `waiters` array plus `cursorKey`; an identical-cursor overlap
coalesces (both settle), a differing cursor is rejected with the typed
`SessionReadSupersessionError` **before** replacing the entry (the in-flight
read keeps its waiters); response, session-error, socket-error and close
paths all settle every waiter (`settleRead`, `settle` error branch,
`drain`/`rejectWaiters`). Tests: "two concurrent identical reads coalesce
onto one request and both resolve" (:897), "a close drains every coalesced
waiter" (:935), supersession assertion (:925). apps/desktop suite 441/0
(exit 0). No waiter can be silently replaced anymore; the r2 pending-forever
counterexample is closed by construction (set only happens when no entry
exists).

### r2 finding 5 (unbounded ancestor scan) — FIXED as specified, with a
documented amortization tradeoff (see M2)
`packages/agent/src/session-lifecycle/inspect.ts:42-82`: ancestry resolves
through descending 256-action `historyPage` windows instead of per-link
`actionById` point reads; attribution stays exact (null only when the walk
reaches the root — no budget truncation, so the r1 attribution bug is not
reintroduced). New regressions spy on the **real** kernel:
`session-inspection.test.ts:714` (300-link turn-less chain, one-action page:
0 point reads, ≤3 page reads, `turnId` null) and :757 (same chain under a
turn: `turnId` "turn-1", 0 point reads, ≤3 page reads). packages/agent suite
852/0 (exit 0). Ordinal/revision window math checked against
`packages/protocol/src/ledger/session-history.ts:26-38` (actions ascend
strictly within `(afterRevision, headRevision]`); consistent.

### r2 finding 6 (transitive-only inventory files unowned) — FIXED
`script/quality-mutation-input.ts:48-61`: `programs` now covers only
`getRootFileNames()` (realpath'd), so transitive-only inventory members enter
the fallback; `quality-mutation-compiler.ts:162-168` mirrors the same covered
set. New regression "transitive-only inventory files enter the fallback
beside native roots and unreferenced files" proves owners
`[["a/index.ts"],["b/value.ts","c/orphan.ts"]]`, zero enumeration errors,
full census, and deterministic candidate ownership including the
consumer-root error preservation. Passed in scripts-tooling-2 (exit 0).

### r2 finding 7 (phase metadata read after the fence check) — FIXED
`apps/openomni/src/gateway.ts:162-199,223-245`: `phaseFacts` is now pure over
`PhaseSources` captured **before** the final `kernel.row` consistency check;
it reads no kernel at all. New regression
`gateway-phase-since.test.ts:167-197` injects a real commit during
`latestOpenTurn` (the exact r2 interleaving) and asserts the typed
`session_gap` with the advanced head — never an old page with phaseSince 900.
apps/openomni suite 558/0 (exit 0).

### r2 hosted failure (Test (agent) foldVersion timeout) — FIXED, deterministic
`packages/agent/test/durable-reconstruction.test.ts:27-33,46-48`:
`childDeadlineMs = 60_000` passed to the existing `bounded()` helper, which
awaits the exact completion signal (child exit + both pipes drained) under a
failure deadline — no sleeps, no polling
(`packages/agent/test/helpers/bounded.ts`: `Promise.race` against the signal,
timer cleared in `finally`). Per-test timeouts sized as multiples of the
deadline. Hosted Test (agent) at this HEAD: **pass, 1m22s** (below).

## 2. Wire freeze
`git diff 8390912c --name-status -- packages/protocol/src/gateway`:
`M gateway/index.ts` (+1 export line only), `A gateway/session-read.ts` (new
file). **No existing frame's Zod shape changed** — `Gateway.schema.ts` and
`events.ts` are untouched. All new frames (`session_read`,
`session_snapshot`, `session_page`, `session_gap`, `receipt` codification,
`session_bound`) are additive and `.strict()`. The receipt schema
(`SessionRead.Receipt`) codifies exactly the frozen base two-key shape. No
Owner STOP. (Deletions elsewhere under `packages/protocol/src` are the
consumer-zero export removals owned by lane A2, reviewed in r1/r2 without a
wire finding; none is a gateway frame.)

## 3. Gates (all run in this session)
Launcher `B = /opt/homebrew/bin/mise exec bun@1.4.1 -- bun`,
cwd `/Users/ino/Develop/openomni-w53`, `/opt/homebrew/bin` stripped from PATH,
`D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python`.

| Command | Exit | Result |
| --- | --- | --- |
| `B run build` | 0 | |
| `B run check-types` | 0 | |
| `B run lint` | 0 | |
| `B run lint:tools` | 0 | |
| `B run lint:docs` | 0 | |
| `B run check-effect-boundaries` | 0 | allowlist `script/conformance/effect-runner-sites.json` = `[]` (read directly) |
| `B run check-written-types` | 0 | `OK: written any/unknown types: 0` |
| `B run script/check-topology.ts` | 0 | |
| `B run script/check-deps.ts` | 0 | |
| `B run script/check-import-cycles.ts` | 0 | |
| `B run script/check-dead-exports.ts` | 0 | |
| `B run script/verify-tsconfig-inheritance.ts` | 0 | |
| `B test --timeout 15000` (root) | 1 | **4670 pass / 1 fail** across 532 files — see M3: the one failure is the pre-existing `watch-sources.test.ts` fs.watch flake, file untouched by this branch |
| `B test --timeout 15000 apps/openomni/test/watch-sources.test.ts` (isolation rerun) | 0 | 8/0 |
| Per-workspace `B test --timeout 15000 --coverage` (protocol, ipc, ledger, llm, policy, channels, agent, openomni, desktop) | 0 each | 502/0, 90/0, 197/0, 409/0, 72/0, 578/0, 852/0, 558/0, 441/0 (inner "(fail)" lines are fixture child-process output inside passing tests) |
| `B run ci test --lane scripts-tooling-1` (serial) | 0 | 253/0 |
| `B run ci test --lane scripts-tooling-2` (serial) | 0 | 81/0 |
| `B run ci test --lane scripts-contracts` (serial) | 0 | 336/0 |
| `B run script/check-patch-coverage.ts --base 8390912c --glob '{packages,apps}/*/coverage/**/lcov.info' --glob '<per-lane script lcov union>'` | 0 | "all changed executable lines are covered" (AST-skips reported per file) |

## 4. Hosted CI (`gh pr checks 1240`, exit 0; head verified = `75914062`, OPEN/DRAFT)
**All 30 checks pass; 1 skip (Publish benchmark history — expected off-main).**
Including the two r2-era failures at the previous head:
- Test (agent): **pass**, 1m22s (run 36526982038/job 109272285263) — the
  `foldVersion` timeout is gone.
- Performance Benchmarks: **pass**, 2m38s (run 36526981991/job 109272078782).
- Patch Coverage: **pass**, 17s — the hosted authoritative gate is green.

## 5. Docs
- `docs/implementation-status.md` W5.3 section: HEAD stated as "`03f70089`
  plus this docs commit" (the docs commit IS `75914062`) — accurate; r2
  findings 1–7 and their fixes are individually recorded (receipt frame
  restored + `session_bound`, shared diagnostic ownership, version-1 footer
  decode, waiter coalescing + supersession error, 256-action ancestry
  windows, pre-fence phase capture, 60s child deadline); gate line
  4671/0 + 253/81/336 matches this session's observations. The "Not claimed:
  CI green, patch coverage" line is now conservative (hosted CI is green) —
  stale in the safe direction, not an overclaim.
- `docs/kernel-references.md:22-27`: session_bound frame + Owner decision +
  ancestry windows described; matches the tree.
- `AGENTS.md` stamp: current (frozen receipt shape, session_bound, allowlist
  `[]`, written types 0, PR #1240 pending merge).
- `docs/SLOP.md` closed rows spot-verified: H12 app-connector — `git diff
  --name-status` shows all three files `D`eleted, `AppConnector` greps to
  zero in repo TypeScript; H16/H17 consistent with the tree. No stale claim
  found that overstates the branch.

## 6. Scope vs 8390912c
299 changed files; every non-`.omo/` file maps to a plan lane (A1 test
helpers/effect-boundaries, A2 protocol census + deletions, A3 written-types
across script/apps/packages, A4 read model incl.
`packages/ledger/src/session/kernel.ts` `childSessionsPage` indexed child
paging, A5 quality tooling + `.github/workflows/ci.yml`, A6 residue/llm
retry/comments), the C1–C3 coverage lanes, the F/F-r2 fix lanes, or the docs
sync. The delta since the r2-reviewed head (`git diff --name-only
19c9d856..HEAD`, 21 non-.omo files) is exactly the six fix-lane commits plus
docs — all owned by F1-r2..F6-r2 briefs. **No orphan files found.** (The full
209-file wave-A scope was reviewed in r1/r2 without a scope finding; this
round re-derived ownership from `plan.md` and spot-checked the
ledger/llm/policy/ipc edits directly.)

## Slop/overfit pass (remove-ai-slops + programming criteria, applied manually)
- New tests are behavioral: wire-order assertion over a real socket
  (session-cursor), spy-counted read bounds on the real kernel
  (session-inspection), a real-commit interleaving (gateway-phase-since),
  real Bun WebSocket close/coalesce paths (gateway-transport), the live
  persisted issue-footer bytes (quality-audit-issues — machine-consumed JSON,
  not prose pinning), and fixture compiler projects driven through both the
  baseline and candidate APIs. No deletion-only tests, no tautologies, no
  implementation-constant mirrors, no sleeps/polling (the one timing constant
  is a failure deadline around an exact signal), no skipped/suppressed tests.
- Production: `previousTotalsSchema` partial decode is boundary parsing of a
  persisted external document (required by the goal); `SessionReadSupersessionError`
  + `cursorKey` is the minimal typed contract the finding demanded; no
  untyped escape hatches (written-types gate prints 0); no needless
  abstraction found.

## Findings

1. **M1 (MEDIUM): the frozen receipt is sent through a side channel that can
   misroute or drop it on a reconnect race.**
   `packages/channels/src/websocket.ts:237-241`. When the handler returns an
   admission, the receipt is sent via `this.connections.get(connection.externalId)`
   rather than through the caller's outcome path. Executed counterexample
   (bun -e, exit 0): for a connection absent from the map, only
   `session_bound` reaches the caller — the receipt is silently dropped; with
   last-wins reconnects (`websocket.ts:79-83`), a second socket declaring the
   same actor externalId would receive the receipt while `session_bound` goes
   to the original socket. Base code never misrouted (the receipt was the
   returned outcome). Impact is narrow — the receipt is a pure ack, the
   desktop transport ignores receipts (`gateway-transport.ts:186-187`), and
   the binding frame routes correctly — so this is not a blocker. Suggested
   follow-up: return both frames through the caller instead of the map send.
2. **M2 (MEDIUM): F5 ancestry cost is amortized, not constant.** The window
   walk (`inspect.ts:50-63`) is O(chain/256) range reads — 256x cheaper than
   r2's counterexample and exact in attribution, but a pathological
   multi-thousand-link turn-less chain still costs work proportional to the
   chain inside one inspection. The r2 finding's alternative (an indexed
   nearest-turn fact) would make it O(1) but needs a schema change. The
   tradeoff is documented in-code and the regression pins the ≤3-window
   contract for realistic chains. Non-blocking; revisit if adversarial
   ledgers become reachable.
3. **M3 (MEDIUM, pre-existing, not caused by this branch): one nondeterministic
   test in the repo.** Root `bun test --timeout 15000` exited 1: `path watch
   native callback observes a created target`
   (`apps/openomni/test/watch-sources.test.ts`) timed out at 15006ms under
   full-suite load, plus its cascading `native path create signal missing`
   unhandled error. The file is byte-identical to base `8390912c` (not in the
   diff); it passed standalone (8/0, exit 0) and inside the apps/openomni
   workspace run (558/0), and hosted Test (openomniApp) is green. The test
   already subscribes to the exact fs.watch signal with a failure deadline —
   the flake is macOS fs.watch latency under load. Reported separately as
   pre-existing; it should not gate this PR but deserves its own issue.
4. **L1 (LOW): `docs/implementation-status.md:111` "Not claimed: CI green,
   patch coverage"** is now outdated in the conservative direction (both are
   green at HEAD). Harmless; refresh in the merge receipt.

## Verdict

**GO-WITH-CONDITIONS.** All seven r2 findings (including the Owner STOP) are
genuinely fixed on the current tree with real, mutant-relevant regressions —
no test was weakened to pass. All 12 local gates exit 0, per-workspace suites
and serial script lanes are 0-fail, patch coverage vs `8390912c` exits 0, and
hosted CI is fully green at the exact reviewed HEAD `75914062`. The wire
freeze holds: no existing frame shape changed; all new frames are additive.

Conditions (non-blocking, to be tracked, none requires a new review round):
1. File a follow-up for M1 (route the frozen receipt through the caller's
   outcome path) — an edge, not a frame-shape violation.
2. File the pre-existing watch-sources flake (M3) as its own issue; do not
   attribute it to this PR.
3. Note M2's amortized bound in the read-model debt ledger.

No merge, commit, push, or external write was performed by this review. The
only working-tree residue created was temp logs/lcov copies under `/tmp` and
the pre-existing modified `review-r3-brief.md` noted at session start.
