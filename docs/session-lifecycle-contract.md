# Unified session lifecycle and transition ownership

**Contract v1 (target freeze for #968).** This is the transition/ownership delta over [kernel-contract.md](kernel-contract.md) §3.2, §5.1-5.4, §5.8 and [core-model.md](core-model.md) §4. Those documents remain authoritative for identity, leases, actions, executor, waiting, and vocabulary; this file freezes only the cross-child transitions, payloads, predicates, and deletion partition required before #969-#973.

## Frozen products and payloads

Canonical state, lease, waiting, operation, and history definitions are owned by `docs/kernel-contract.md` §3.2, §5.1-5.4, §5.8 and `docs/core-model.md` §4; this file does not duplicate them. The additional frozen payload vocabulary is `occurrence.open {occurrenceId,sessionId,turnId,parentActionId,generation,inputHash,source}`, `occurrence.result {occurrenceId,terminal,reason?,output?}`, `request.answer_admission {requestId,invocationId,receivedAt,deadline,bindingDigest}`, `reply.late_unknown {requestId,receivedAt,deadline,bindingDigest}`, and parent `inbox.delivery {inboxId,parentActionId,childId,terminal}`.

## Reusable decision/apply/dispatch contract

For every row below, **decision** validates the named predicate and returns a typed refusal or immutable payload; **apply** atomically checks expected revision/fence and appends/updates; **dispatch** runs only after the apply receipt. Replay folds actions and dispatches zero effects. The existing ledger commit validates fence/revision/batch/inbox conditions (`packages/ledger/src/storage/sqlite-l0-adapter.ts:369-464`), and executor effects use its fenced action port (`packages/agent/src/session-admission.ts:216-243`).

## Total transition table

| Product/input and legal predicate | Result/payload/event | Decision owner | Apply collaborator | Dispatch collaborator |
|---|---|---|---|---|
| `absent -> idle`, valid identity/config | `session.created {id,role,parentId}` | `packages/agent/src/session-handle.ts:82-110` | `packages/ledger/src/session/kernel.ts:39-71` | none |
| `idle + prompt`, live lease and prompt policy admitted | `inbox.consumed {inboxId}` + `turn.intent {turnId,resultId,generation,inboxIds}` | `packages/agent/src/session-admission.ts:58-88` | `SessionHandleStore.commit` at `packages/agent/src/session-admission.ts:89-100` | `packages/agent/src/session-turn.ts:65-176` runner |
| `idle + interrupt/resume`, no open turn | `delivery.noop {inboxId,kind}` | `packages/agent/src/session-controller.ts:255-302` | `SessionHandleStore.commit` at `packages/agent/src/session-admission.ts:346-362` | none |
| `running + prompt` at boundary | `delivery {inboxId,turnId,boundary:"before_llm"}` | `packages/agent/src/session-turn.ts:314-368` | same function's `SessionHandleStore.commit` (`:323-334`) | boundary runner `packages/agent/src/session-turn.ts:65-176` |
| `running + runner result` | `turn.result {turnId,resultId,kind:"result",text,usage?}` | `packages/agent/src/session-turn.ts:371-411` | its `seal` commit (`packages/agent/src/session-turn.ts:371-411`) | none after terminal |
| `running + runner waiting` | `turn.result {kind:"waiting",reason:"live_wait",alarmIds}` | `packages/agent/src/session-turn.ts:371-411` | its `seal` commit (`:371-411`) | alarm/wake admission only after commit |
| `running + runner interrupted` | `turn.result {kind:"interrupted"}` | `packages/agent/src/session-turn.ts:237-247` | `seal` in `packages/agent/src/session-turn.ts:371-411` | abort signal from same turn (`:237-258`) |
| `running + runner error` | `turn.result {kind:"error",text}` | `packages/agent/src/session-turn.ts:371-411` | its `seal` commit (`:371-411`) | none after terminal |
| `running + interrupt` | row interrupted, then one interrupted terminal; predicate is live owner/fence | **Current:** `packages/agent/src/session-controller.ts:222-239`; **target move:** #969's common session fold owns this CAS and deletes this direct branch | `SessionHandleStore.commit` in `session-controller.ts:225-235` until move | `state.controller.abort()` (`:237-239`), then turn seal |
| interrupted + queued prompt, no resume | queue remains; no dispatch | `packages/agent/src/session-controller.ts:255-302` | no mutation (read guard) | none |
| interrupted + resume, retained runner absent | new `turnId/resultId`, latest generation | `packages/agent/src/session-admission.ts:298-343` | its commit (`:323-334`) | `session-turn.ts:65-176` |
| crash-open | same IDs/captured generation; pending interrupt seals; exhausted budget errors | `packages/agent/src/session-admission.ts:247-295` | `seal` (`:252-258`) or resume commit (`:275-286`) | runner only on successful resume |
| interrupted terminal + retained effect | lease remains held until runner settles; then release/hibernate | `packages/agent/src/session-turn.ts:237-309` | `releaseHeldLease` (`packages/agent/src/session-configuration.ts:115-131`) | retained continuation (`session-turn.ts:289-308`) |
| operation pre deny/approval | `operation.result blocked_pre`; approval payload retains intent/hash/generation | `packages/agent/src/executor.ts:148-198` | `appendResult` (`packages/agent/src/executor.ts:217-247`) | no body |
| operation body + post deny | `operation.result blocked_post {disposition}` | `packages/agent/src/executor.ts:260-273` | `finishRun`/append result (`:324-382`) | registered reverter only (`:324-382`) |
| body result/failure/cancel | one positional `operation.result` terminal | `packages/agent/src/executor.ts:217-275` | same append calls | tool body/wave `runWaveBodies` (`:200-215`) |
| alarm arm | valid new alarm ID, no duplicate active key | `packages/ledger/src/storage/sqlite-l0-adapter.ts:577-612` | same atomic arm/create | timer/evaluator reads armed row |
| alarm cancel | state `armed` and matching owner/fence | `packages/ledger/src/storage/sqlite-l0-adapter.ts:614-628` | same CAS `armed->cancelled` | none; due scan excludes it |
| alarm fired | due, state `armed`, evaluator lease valid | #971 alarm fold | target alarm CAS | evaluator effect after receipt |
| alarm paused | budget/stop policy; state nonterminal | #971 alarm fold | target alarm CAS | none |
| alarm rearm | recurrent completion, future deadline, distinct dedupe key | #971 alarm fold | target alarm CAS/create | evaluator timer after receipt |
| alarm wake admission | fired alarm, live session, unique inbox key | #971 alarm fold | target `commitInbox` + session commit | receiving controller |
| occurrence open | stable ID, pinned generation/hash, evaluator lease | #971 occurrence fold | target action commit | evaluator after receipt |
| occurrence result/dedupe | open occurrence; one terminal CAS; duplicate returns existing | #971 occurrence fold | target terminal/dedupe CAS | wake admission after receipt |
| child terminal | authenticated child terminal; parent exists | **Target owner #969** | canonical outbound obligation + parent `commitInbox` | parent controller/executor |
| configuration | authorized owner and live lease; generation increments | `packages/agent/src/session-configuration.ts:17-89` | `SessionHandleStore.commit` inside `:65-89` | none |
| late/duplicate/stale input | §4 eligibility/refusal rules | named owner in §4 | ledger CAS | none if refused |

## Deadline and late-input policy

Eligibility is unconditional and precedes CAS. An approval answer at or after `expiresAt` is `stale_approval`, regardless of whether its timer callback ran; a pre-expiry authenticated answer may win. The shipped owner and evidence are `executor-approval.ts:22-56` (clock/expiry and authentication) and timeout action `:113-138` (timer callback). A delayed timer therefore cannot make an ineligible answer eligible.

For generic request/reply, #969's canonical policy row is `request.answer_admission`: authenticate the reply binding, compare authoritative `clock()` to the request deadline, and include the received-at timestamp and binding digest in the decision payload. If `receivedAt >= deadline`, the old request **always** records `reply.late_unknown {requestId,receivedAt,deadline,bindingDigest}`; it never completes, reopens, or cancels the old request, and the reply never becomes a new inbox input. If the reply is authenticated and `receivedAt < deadline`, `request.answer` may terminally complete once; unauthenticated, mismatched, duplicate, or post-terminal inputs always record/refuse as `reply.rejected|duplicate` without effects. Timeout eligibility records `request.expired {deadline}` and terminal `unknown`; cancel wins only through the same open-state CAS. This is #969's target decision owner, with the current reply fold at `apps/openomni/src/delegation/kernel.ts:771-783` explicitly replaced.

## Concrete supplied deterministic harness traces

The required harness is supplied as a deterministic trace table over a fake clock/entropy and an in-memory `SessionHandleStore`: each step asserts payload, revision, state, winner, and effect count. A valid implementation must run these exact cases without sleeps: A/B/C/D approve (`pre all; B approve; bodies A,C,D; E=4`), refuse (`B blocked_pre; E=3`), timeout (`answer at deadline -> stale; B blocked_pre; E=3`), interrupt while approval (`no bodies; cancelled results; E=0`), terminal interrupt/resume (`T1/R1` then fresh `T2/R2`), crash-open (`same T1/R1`), delayed timer/late reply (`late_unknown; no inbox`), cancel/reply and duplicate (first eligible CAS terminal, loser existing terminal), alarm arm/cancel/fire/pause/rearm/dedupe, and replay (same snapshot, `E=0`). This is a supplied harness specification, not a claim it has shipped; #973 executes it in named conformance test symbols.

## Exclusive source-bound deletion receipts

Each symbol is assigned once; no ranges overlap. `keep` means the named symbol remains; `move` means the named child replaces it; `delete` means that child removes it and its listed tests. Immutable migrations remain.

* **#969:** `move apps/openomni/src/delegation/kernel.ts:createDelegationKernel` logical request decision to canonical request fold; `delete` `settlementWaiters` (`:124-130`), `settle` (`:308-347`), `deliverWake` (`:349-380`), `arm` (`:382-407`), `awaitDelegation` (`:657-752`), `settleFromReply` (`:771-783`); `keep` `DelegationDriver.prepare/run` (`:41-52`) and channel correlation. Delete tests whose sole symbols are those functions; #969 owns `apps/openomni/src/tools/authority/delegation.ts:executeAwaitDelegation,executeCancelDelegation` request writers and `apps/openomni/test/delegation*.test.ts` tests, plus forward migration/retention. #969 also owns `apps/openomni/src/delegation/process-driver.ts` transport receipt symbols, which remain keep unless they are logical settlement writers.
* **#970:** `move` `packages/agent/src/session-admission.ts:resumeTurn,resumeInterrupted` (`:247-343`) and `packages/agent/src/session-turn.ts:runTurn` retained continuation (`:65-176,237-309`) to the common recovery owner; `keep` `packages/agent/src/core/execution/run.ts:run` provider-attempt symbols. `delete` only duplicate recovery/replay test symbols, not process ACK in `apps/openomni/src/delegation/process-entry.ts:processEntry` (keep). #970 owns `packages/agent/test/session-resume-reopen.test.ts` and `apps/openomni/test/process-session-cancel-race.test.ts` recovery fixtures; immutable migrations remain and no WorkItem/Attempt rows.
* **#971:** `move` occurrence/alarm decisions into symbols adjacent to `packages/agent/src/session-stop-evidence.ts:sessionStopEvidence` (`:29-39`); `keep` `packages/ledger/src/storage/sqlite-l0-adapter.ts:commitAlarm/commitAlarmCancellation` (`:577-628`) and `packages/protocol/src/ledger/l0.ts:Alarm` schema (`:508-530`); `delete` only duplicate evaluator/monitor lifecycle symbols and their tests, `apps/openomni/src/delegation/kernel.ts:createDelegationKernel` has no monitor/evaluator symbol at HEAD, so no such deletion is assigned here. #971 owns any guarded forward migration; immutable migrations and operational alarm rows stay.
* **#972:** `move` `packages/agent/src/session-history.ts:sessionHistory` (`:6-142`) as sole action projection and diagnostic readers; `delete` legacy logical delivery/request history symbols and duplicate projection writers/tests, while `keep` physical message/part bytes and immutable migrations pending archive decision. #969 owns `apps/openomni/src/tools/authority/delegation.ts:executeAwaitDelegation,executeCancelDelegation` request writers/tests; #972 owns only `sessionHistory` projection symbols.
* **#973:** `keep` all production symbols above; `delete` only named obsolete conformance fixture symbols after #969-#972 receipts, and execute the supplied trace harness. It owns no production move/delete; its only deletion is named obsolete conformance fixture symbols listed by #969-#972 receipts.

## References and boundary

See [kernel-contract.md](kernel-contract.md) §3.2, §5.1-5.4, §5.8 and [core-model.md](core-model.md) §4 for canonical invariants. This delta supersedes only independent logical Wait/approval/delivery settlement at #969's cutover; physical channel correlation, alarm rows, provider provenance, and immutable migrations remain. No second engine, policy/approval/watcher, WorkItem/Attempt domain, compatibility adapter, dual path, universal rollback, or exactly-once external-effect claim is introduced.
