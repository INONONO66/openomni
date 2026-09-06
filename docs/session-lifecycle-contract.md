# Unified session lifecycle and transition ownership

**Contract version 1, target freeze for #968.** This freezes the existing action/session schema's decision, apply, and dispatch boundaries for #969-#973: session, turn, prompt/reply, approval, operation/wave, alarm, monitor occurrence, lease, and delegation-child terminal lifetimes. It freezes the traces below as expected products, not as a claim that all target cutovers have shipped. Canonical vocabulary and broad invariants remain in [kernel-contract.md](kernel-contract.md) and [core-model.md](core-model.md); this document is only their versioned transition/ownership delta.

## 1. State products (shipped vs target)

The **shipped** session row is `idle | running | interrupted`, with identity, revision, generation pointers, and fenced lease fields (`packages/protocol/src/ledger/l0.ts:79-103`). The action tree is append-only and projected by `session-history` (`packages/agent/src/session-history.ts:5-14`). The target product is the following orthogonal tuple, not a giant enum:

* **Lifecycle:** `idle`, `running`, `interrupted`; a turn is `open -> result | waiting | interrupted | error`, keyed by `turnId` and `resultId` (`packages/agent/src/session-contract.ts:79-105`).
* **Residency lease:** `free`, `held(owner,fence,expiry)`, or **retained** (`held` after an interrupt while an abort-ignoring runner/effect is alive). Live means owner/fence match and expiry is not past; expired permits takeover, but release is not a hand-off (`packages/agent/src/session-contract.ts:124-143`; `packages/agent/src/session-configuration.ts:105-123`).
* **Intake/scheduling:** inbox `prompt | interrupt | resume`; one active drive; an open turn may drain prompt delivery at its boundary; interrupted input waits for explicit resume; idle control-only input is consumed as a no-op (`packages/agent/src/session-controller.ts:255-302`; `packages/agent/src/session-turn.ts:314-368`; `packages/agent/src/session-admission.ts:346-362`).
* **Operation/effect (shipped):** `pre -> intent? -> approval? -> body -> post -> result`; terminals are `executed`, `blocked_pre`, **`blocked_post`**, `cancelled`, and `failed`. `blocked_post` additionally carries disposition `reverted | irreversible`; a registered reverter is best effort, never universal rollback (`packages/agent/src/executor.ts:260-273`, `:324-382`; `packages/agent/src/executor-contract.ts:78-85`). Policy-decision facts and session prompt/turn records are distinct products, not recursively admitted operations (`packages/agent/src/executor.ts:57-102`).
* **Alarm/control (shipped where waiting depends on it):** an alarm has stable identity, `at | watch`, and operational state `armed | cancelled | fired | paused` (`packages/protocol/src/ledger/l0.ts:508-530`). Arm is append-plus-row creation; cancel is an atomic `armed -> cancelled` CAS, and cancelled alarms are not due (`packages/ledger/src/storage/sqlite-l0-adapter.ts:577-628`). Waiting requires `live_wait` and nonempty alarm IDs (`packages/protocol/src/ledger/l0.ts:341-377`).
* **Occurrence (target, with shipped inputs):** each monitor/evaluator/request/reply occurrence has an immutable `occurrenceId`, parent session/turn/action, pinned generation and input hash, an open/terminal product, and an authenticated source. Its evaluator lease is separate from the session lease. #971 owns adding the action vocabulary and evaluator fold; current shipped waiting evidence is armed alarms plus current-turn actions (`packages/agent/src/session-stop-evidence.ts:29-39`).
* **Request/reply and child settlement (target):** a request has one invocation identity, deadline, answer binding, and outbound obligation; its child terminal becomes a durable parent inbox message. Physical accepted/rejected/unknown transport receipts may remain, but logical completion is the canonical action/session fold. This supersedes the independent logical settlement/wake/await path described below.

## 2. Reusable decision/apply contract

Version 1 uses existing action schemas and one generic executor/session commit boundary:

1. **Decision:** the named owner validates `(region, current snapshot/revision, input, pinned generation, deadline evidence, lease fence)` and returns either a typed refusal or an immutable `Decision` containing action kind/op/value, expected revision/fence, IDs, and an effect plan. No effect runs here.
2. **Apply:** the sole durable store commit validates expected revision, fence, inbox IDs, and terminal uniqueness, then appends actions/consumes inbox/updates operational rows atomically. A stale fence, revision, already-sealed turn, expired approval, or invalid transition returns a typed refusal (`packages/agent/src/session-admission.ts:216-243`; storage validation `packages/ledger/src/storage/sqlite-l0-adapter.ts:369-464`).
3. **Dispatch:** only after a successful receipt does the owner run the effect plan. The effect must append its result through the same fenced commit; post-policy denial is `blocked_post` and records disposition. Replay runs decision validation and apply-fold reconstruction only: it dispatches zero effects (`packages/agent/src/session-history.ts:124-141`).

The action vocabulary is: inbox `prompt|interrupt|resume`; turn `intent|resume|terminal`; operation `policy.decision`, operation intent/result; approval `request|answer|timeout`; alarm `arm|cancel`; occurrence `open|terminal`; and parent inbox delivery. Existing event/ID payloads are reused: inbox IDs, turn/result IDs, action IDs, alarm IDs, approval IDs, occurrence IDs, and delegation IDs. A bus/watch observation is emitted only after commit and is never a command or truth source.

## 3. Total transition table

Each row names the **decision owner** first, then its apply collaborator and dispatch owner. “Target move” is explicit where a child must relocate authority.

| Current product and input | Legal result/guard | Decision owner (current boundary or target move) |
|---|---|---|
| absent -> idle | create identity/configuration; no runner effect | **Shipped:** `session-handle.ts:82-110` -> ledger initialization `ledger/src/session/kernel.ts:39-71`; #968 retains this boundary. |
| idle + prompt | acquire live lease, policy-admit prompt, consume inbox, append turn intent, then run | **Shipped:** admission `session-admission.ts:58-130`; apply `SessionHandleStore.commit` `:89-100`; dispatch runner `session-turn.ts:65-176`. |
| idle + interrupt/resume | consume as no-op; no turn | **Shipped:** controller `session-controller.ts:255-302`; apply admission `session-admission.ts:346-362`. |
| running + prompt | append/consume at same turn boundary; preserve IDs; execute only after boundary | **Shipped:** turn boundary `session-turn.ts:314-368`; apply same session commit. |
| running + interrupt | commit row `running -> interrupted`, abort controller; later seal terminal; stale result cannot commit | **Shipped decision boundary:** controller `session-controller.ts:222-239`; **target clarification:** #969 may move this CAS decision into the common session transition function, but must delete the direct duplicate, leaving one owner; apply remains ledger CAS. |
| interrupted + queued prompt without resume | retain queued prompt; do not dispatch | **Shipped:** controller `session-controller.ts:255-302`. |
| interrupted + resume | acquire only after retained runner settles; mint new turn/result IDs and latest generation | **Shipped:** admission `session-admission.ts:298-343`; retained guard `session-admission.ts:237-309`. |
| crash-open | reuse turn/result IDs and captured generation; bounded resume; pending interrupt seals interrupted; exhausted budget seals error | **Shipped:** admission `session-admission.ts:247-295`; apply turn commit/seal. |
| interrupted terminal + retained effect | keep heartbeat/lease; release only when runner/effects settle, then hibernate | **Shipped:** turn `session-turn.ts:237-309`; controller close/hibernate `session-controller.ts:287-302`. |
| open operation + pre deny | append intent only where required, append `blocked_pre`; no body | **Shipped:** executor `executor.ts:148-173`, `:232-247`. |
| open operation + approval | retain original parsed intent/hash/generation; all wave approvals resolve before any body | **Shipped:** executor `executor.ts:174-215`. |
| approval + refuse/timeout | `blocked_pre`; admitted siblings proceed in original order | **Shipped:** executor `executor.ts:232-247`; approval expiry eligibility `executor-approval.ts:22-56`. |
| body + post deny | `blocked_post(disposition=reverted|irreversible)`; run only registered reverter, never rollback by assumption | **Shipped:** executor `executor.ts:260-273`, `:324-382`. |
| body + result/failure/cancel | append one terminal result; positional wave output; sequential barriers remain | **Shipped:** executor `executor.ts:217-275`. |
| alarm arm/cancel | arm creates row/action; cancel CAS only from armed; due excludes cancelled | **Shipped:** ledger adapter `sqlite-l0-adapter.ts:577-628`; target evaluator ownership #971. |
| occurrence open/evaluate/terminal | evaluator lease + pinned generation; one terminal CAS; wake admission only after commit | **Target:** #971 moves decision into occurrence action fold; current live-wait evidence remains `session-stop-evidence.ts:29-39`. |
| child terminal | append durable outbound obligation, idempotently deliver parent inbox message; receiving executor admits it | **Target:** #969 moves this from delegation logical settlement/wake to canonical request fold. |
| deadline / late input | see §4; eligibility precedes CAS | **Shipped approval boundary:** `executor-approval.ts:22-56`; **target request boundary:** #969 canonical fold. |
| configuration | new generation only after policy authorization; preserve running lease if owner still holds it | **Shipped:** `session-configuration.ts:17-89`; apply session kernel generation actions. |
| any stale fence/revision/closed terminal | typed refusal; no effect, no state mutation | **Shipped apply:** ledger CAS `sqlite-l0-adapter.ts:369-464`; executor guard `session-admission.ts:216-243`. |

## 4. Deadline, precedence, and concrete traces

Eligibility is checked against the authoritative clock **before** CAS arbitration. An approval answer arriving at or after its expiry is `stale_approval`, even if the timeout callback has not fired; a valid pre-expiry answer may win if its authenticated answer commit reaches the fold first (`packages/agent/src/executor-approval.ts:22-56`). The timeout records its own action separately (`packages/agent/src/executor-approval.ts:113-138`). A generic request late answer never reopens the old request: #969 records a late/unknown receipt and, if policy permits, creates a new inbox input with a new occurrence ID. A duplicate answer/result is an idempotent no-op returning the existing terminal. Cancel versus reply uses the same eligibility and first successful terminal commit; a loser gets the existing terminal. Changed fence or sealed turn yields `SessionCommitError(reason="stale")` (`packages/agent/src/session-admission.ts:216-243`).

Concrete traces (IDs are fixed labels for the trace; `E` is dispatched effect count):

* **A/B/C/D approve:** `I(A),I(B),I(C),I(D)` -> all `pre`; `B approval=request`; `B answer=approved`; bodies `A,C,D` in positional order with `D` at its sequential barrier; each result; `E=4`.
* **A/B/C/D refuse:** same pre/intents -> `B refused`; `B blocked_pre`; `A,C,D` bodies/results in order; `E=3`.
* **timeout:** `B approval=request` at `t<deadline`; answer at `t>=deadline` -> `stale_approval`; timeout action -> `B blocked_pre`; `E=3`.
* **interrupt while approval waits:** all pre actions, `B approval=request`, interrupt -> wave cancellation; no body starts; admitted intents receive cancelled results; `E=0`.
* **terminal interrupt then resume:** `T1/R1` open -> interrupt terminal; resume -> `T2/R2`, latest generation; `E` only for T2. **Crash-open:** `T1/R1` open -> recovery `resume(T1,R1,pinnedGeneration)`, bounded count; no duplicate body for settled slots.
* **late reply / cancel / duplicate:** request open -> expiry-eligible timeout wins and records unknown; late reply records late receipt/new-input only; cancel after terminal returns existing terminal; duplicate result returns existing terminal; no old request reopens.
* **alarm:** `alarm.arm(A1)` -> armed; cancel CAS -> cancelled; due scan excludes A1; waiting evidence cannot cite A1 after cancel. A waiting terminal always carries `live_wait` plus nonempty alarm IDs.
* **replay:** fold any trace including `blocked_post` and retained lease rows -> same snapshot, `E=0`.

## 5. Exact child boundaries and deletion receipts

A path is assigned once. Ranges within a shared file are separate symbols; immutable migrations are never deleted. Each child owns its deletion and dependent fixture census; #973 only verifies the final absence.

### #969 waiting/delivery cutover

* **Move/replace:** `apps/openomni/src/delegation/kernel.ts:createDelegationKernel` and `settle`, `deliverWake`, `arm`, `awaitDelegation`, `settleFromReply` (`:250-783`) move logical request terminal, wake, and await decisions to the canonical action/session fold; retain only physical driver preparation/transport receipt and channel correlation.
* **Delete:** module-level `settlementWaiters` (`:124-130`), logical `settle`/`deliverWake`/`markWoken` path (`:303-380`), delegation timer terminal fold (`:382-406`), and direct reply-to-completed fold (`:771-783`), plus their dedicated tests/fixtures. Child terminal instead becomes parent inbox message. Keep `apps/openomni/src/delegation/*-driver.ts` physical drivers and required Wait correlation; no compatibility path.
* **Depends on/owned tests:** delegation kernel tests and channel reply tests; data disposition is forward migration/retention owned by #969, with immutable historical migrations retained.

### #970 recovery/retry/restoration

* **Move/replace:** `packages/agent/src/session-admission.ts:247-343` recovery/resume decisions and `packages/agent/src/session-turn.ts:237-309` retained-effect continuation; target common transition fold remains the sole apply owner.
* **Delete:** any recovery/retry authority in `apps/openomni/src/delegation/process-entry.ts` beyond transport ACK; any duplicate resume/replay fixtures that re-run settled effects. Keep `packages/agent/src/core/execution/run.ts` provider-attempt logic and provenance; never add WorkItem/Attempt rows.
* **Depends on/owned tests:** session admission/turn recovery tests and process crash traces; immutable ledger migrations retained.

### #971 monitor/occurrence alignment

* **Move/replace:** `packages/agent/src/session-stop-evidence.ts:29-39` remains the current alarm evidence reader; add occurrence decision/fold adjacent to it and `packages/protocol/src/ledger/l0.ts:341-377,508-530` vocabulary. `packages/ledger/src/storage/sqlite-l0-adapter.ts:577-628` remains alarm arm/cancel CAS.
* **Delete:** only monitor/evaluator logical lifecycle branches and duplicate evaluator watchers/leases in their current consumers; do **not** delete armed/cancelled operational alarm rows, legitimate provider provenance, or immutable migrations. Exact evaluator consumer census and forward migration/retention decision belong to #971.
* **Depends on/owned tests:** monitor/evaluator and alarm conformance fixtures; no polling/sleep bridge.

### #972 history/diagnostic projections

* **Move/replace:** `packages/agent/src/session-history.ts:6-142` is the sole canonical projection reader; extend it for canonical request/reply/approval/occurrence actions. Diagnostic readers consuming action trees move here, not #969.
* **Delete:** legacy logical delivery/request history readers and duplicate JSON/event projection writers; assign each old reader/test to #972's deletion census. Keep physical message/part bytes and immutable migration files pending an explicit archive/retention decision; no effect dispatch during projection.
* **Depends on/owned tests:** session-history and diagnostic projection tests only; #969 owns request writers and old request fixtures, so #972 does not edit those fixtures.

### #973 final conformance

* **Owns only:** repository-wide semantic census and model/property/real-surface tests after #969-#972; it does not own production deletion. Harness cases are the traces in §4: invalid transition refusal, terminal uniqueness, deterministic replay `E=0`, mixed wave, recovery, late input, alarm cancellation.
* **Delete:** no shared production path. It removes only obsolete final conformance fixtures that reference already-deleted symbols, with the deleting child named in the receipt; no WorkItem/Attempt fixtures are revived.

## 6. References and non-negotiables

Use [kernel-contract.md](kernel-contract.md) for session/lease/turn IDs, executor ownership, wave gating, attempts, waiting, compaction, and terminal recovery semantics; use [core-model.md](core-model.md) for durable vocabulary and the Wait boundary. This document supersedes only their independent logical Wait/approval/delivery lifecycle claims at the #969 cutover; physical channel correlation and operational alarm rows remain legitimate until their assigned child replaces the logical fold.

There is one transition authority, one policy compiler, one approval lane, and one watcher/observation surface. No WorkItem/Attempt revival, second kernel/policy/approval engine, compatibility adapter, dual path, universal rollback, or exactly-once external-effect claim.
