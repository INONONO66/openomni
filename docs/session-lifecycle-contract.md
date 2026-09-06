# Unified session lifecycle and transition ownership

**Contract v1 (target freeze for #968).** This delta uses [Durable session identity and runtime ownership](kernel-contract.md#durable-session-identity-and-runtime-ownership), [L2 action executor](kernel-contract.md#l2-action-executor), [Session L3 execution contract (#937)](kernel-contract.md#session-l3-execution-contract-937), [State and the ledger fold](kernel-contract.md#state-and-the-ledger-fold), and [Waiting on the world](core-model.md#waiting-on-the-world) as authority. It freezes only cross-child transitions and deletion receipts.

## Products and apply contract

Terminal occurrence values are `completed|failed|cancelled|expired|deduped`. Payloads are `occurrence.open {occurrenceId,sessionId,turnId,parentActionId,generation,inputHash,source}`, `occurrence.result {occurrenceId,terminal,reason?,output?}`, `request.answer_admission {requestId,invocationId,receivedAt,deadline,bindingDigest}`, `reply.late_unknown {requestId,receivedAt,deadline,bindingDigest}`, and `inbox.delivery {inboxId,parentActionId,childId,terminal}`. A decision validates its predicate and returns a refusal or immutable payload; apply checks expected revision/fence and commits; dispatch occurs only after the receipt. The ledger commit checks fence, revision, batch, and inbox conditions (`packages/ledger/src/storage/sqlite-l0-adapter.ts:369-464`).

## Transition ownership

| Source -> destination | Trigger/eligibility and payload | Decision | Apply | Dispatch |
|---|---|---|---|---|
| `absent -> idle` | valid identity/config; `session.created {id,role,parentId}` | `createSession` in `packages/agent/src/session-handle.ts:82-110` | `materialize` in `packages/ledger/src/session/kernel.ts:39-71` | none |
| `idle + prompt -> running` | live lease and admitted prompt; `inbox.consumed {inboxId}`, `turn.intent {turnId,resultId,generation,inboxIds}` | `createSessionAdmission` in `packages/agent/src/session-admission.ts:58-88` | `SessionHandleStore.commit` in `packages/agent/src/session-admission.ts:89-100` | `createSessionTurn` in `packages/agent/src/session-turn.ts:65-176` |
| `running + result -> idle` | runner terminal; `turn.result {turnId,resultId,kind:"result",text,usage?}` | `runTurn` in `packages/agent/src/session-turn.ts:371-411` | its `seal` commit, same path | none |
| `running + waiting -> running` | live wait; `turn.result {kind:"waiting",reason:"live_wait",alarmIds}` | `runTurn` in `packages/agent/src/session-turn.ts:371-411` | `SessionHandleStore.commit`, same path | `createAlarms` wake target, #971 |
| `running + interrupted -> interrupted` | owner interrupt; `turn.result {kind:"interrupted"}` | `session-controller` branch in `packages/agent/src/session-controller.ts:222-239` | `SessionHandleStore.commit` in same path | abort signal, then `runTurn` seal |
| `interrupted + resume -> running` | no open retained runner; new IDs/latest generation | `createSessionAdmission` in `packages/agent/src/session-admission.ts:298-343` | its commit, `:323-334` | `createSessionTurn` in `packages/agent/src/session-turn.ts:65-176` |
| `crash-open -> running|idle` | same IDs/generation; pending interrupt seals; exhausted budget errors | `createSessionAdmission` in `packages/agent/src/session-admission.ts:247-295` | `seal`/resume commit, `:252-286` | runner only after resume |
| `alarm arm: absent -> armed` | `id,sessionId,kind,fireAt,spec?`; no active key duplicate; owner is caller with session lease | `createAlarms().arm` in `packages/ledger/src/storage/sqlite-l0-adapter.ts:571-612` | same `arm` collaborator | none |
| `alarm cancel: armed -> cancelled` | matching `id`, armed row; owner/fence; payload `id,updatedAt` | `createAlarms().cancel`, same path `:613-628` | same `cancel` collaborator | none |
| `alarm fire: armed -> fired` | due `fireAt <= at`; evaluator acquires/renews lease before decision; payload `{alarmId,fireAt,occurrenceId}` | #971 `evaluateOccurrence` in `packages/agent/src/session-stop-evidence.ts:7-73` | #971 alarm fold | occurrence evaluator |
| `alarm pause: armed|fired -> paused` | policy budget/stop only; payload `{alarmId,reason}`; #971 owner | `sessionStopEvidence` in `packages/agent/src/session-stop-evidence.ts:7-73` | #971 alarm fold | none |
| `alarm resume: paused -> armed` | only #971 evaluator/owner; payload `{alarmId,nextAt}`; duplicate paused requests refuse | #971 alarm fold | #971 alarm fold | due scan |
| `alarm rearm: fired|paused -> armed|fired` | active key is `(sessionId,kind,fireAt,spec.value)`; duplicate key returns `deduped` and does not arm. Recurrent fired -> armed with `nextAt`; one-shot fired -> fired plus `alarm.complete`; paused rearm -> armed only for recurrent, one-shot refusal | #971 alarm fold | #971 alarm fold | `sessionStopEvidence` |
| `alarm wake: fired -> fired` + inbox delivery | one delivery per `(alarmId,occurrenceId,fireAt)`; duplicate is `deduped`; payload `inboxId,parentActionId,childId,terminal` | #971 alarm fold | #971 alarm fold | `pendingInbox` in `packages/ledger/src/session/kernel.ts:90-97` |
| `occurrence open: absent -> open` | stable IDs, pinned generation/hash, evaluator lease; occurrence payload above | #971 `sessionStopEvidence` | `materialize` in `packages/ledger/src/session/kernel.ts:39-71` | evaluator |
| `occurrence result: open -> completed|failed|cancelled|expired|deduped` | one terminal CAS; duplicate terminal input returns `deduped`, stale input refuses | #971 `sessionStopEvidence` | `commit` in `packages/ledger/src/session/kernel.ts:84-90` | none |
| `late/duplicate/stale -> refused` | `awaitApproval` rejects stale at `packages/agent/src/executor-approval.ts:22-56`; duplicate/precondition refusal is `runTool` in `packages/agent/src/tool-dispatcher.ts:185-205` | those named symbols | no mutation | none |

## Late-input policy

`receivedAt >= deadline` records `reply.late_unknown` and never reopens or creates inbox input. Authenticated `receivedAt < deadline` may win the open-state CAS once; unauthenticated, mismatched, duplicate, and post-terminal replies record `reply.rejected|duplicate`. Timeout records `request.expired {deadline}` and terminal `unknown`; cancel wins only through the same CAS. The approval timeout callback is `packages/agent/src/executor-approval.ts:113-138`.

## Deterministic harness (r0 is the initial snapshot)

Fixture IDs are fixed (`S`, `T1`, `R1`, `A1`, `I1`), owner `o`, fence `7`, clock `1000`, deadline `1100`. Every listed action is one commit unless marked `refuse`; replay must equal **the state product of the row's final revision**, with zero effects.

| Case; fixture actions (minimal payload) | Expected state/revision after each action | Actions/observations; effect count; race winner |
|---|---|---|
| approved path: `prompt{inboxId:P}`, `pre{A,B,C,D}`, `approval.answer{B,approved}`, `body{A,B,C,D}`, `result{A,B,C,D}` | `running/r1`; `waiting/r2`; `running/r3`; `running/r4`; `running/r5`; `running/r6`; `running/r7`; `idle/r8` | `delivery(P,T1)`, four `turn.intent/result`, `Tool Started/Completed A..D`; E=4; approval wins before body |
| terminal interrupt: `prompt{P}`, `interrupt{I1}` | `running/r1`; `interrupted/r2` | `delivery`, `turn.intent`, `turn.result(interrupted)`; E=0; interrupt wins |
| resume: `resume{I1}`, `result{T2}` | `running/r1`; `idle/r2` | `turn.intent(T2)`, `turn.result`; E=0; resume commit wins |
| crash-open recovery: `open{T1,R1,generation:1}`, `recover{T1,R1}` | `running/r1`; `idle/r2` | `turn.intent`, `turn.result(error)`; E=0; recovery seal wins |
| delayed timer/late reply: `approval.request{B,deadline:1100}`, `reply{B,receivedAt:1100}` | `waiting/r1`; `unknown/r2` | `approval.timeout`, `reply.late_unknown`; E=0; timeout wins |
| cancel-vs-reply race: `request{Q}`, `cancel{Q}`, `reply{Q}` | `waiting/r1`; `cancelled/r2`; `cancelled/r2` (refuse) | `request.open`, `request.cancel`, `reply.duplicate`; E=0; cancel CAS wins |
| duplicate input: `prompt{P}`, `prompt{P}` | `running/r1`; `running/r1` (refuse) | `delivery(P)`, `duplicate`; E=0; first CAS wins |
| alarm fire/pause/rearm/dedupe: `arm{A1,fireAt:1000}`, `due{at:1000}`, `pause{A1}`, `rearm{A1,nextAt:1100}`, `rearm{A1,nextAt:1100}` | `armed/r1`; `fired/r2`; `paused/r3`; `armed/r4`; `armed/r4` (refuse/deduped) | `alarm.arm`, `alarm.fire`, `alarm.pause`, `alarm.rearm`, `occurrence.deduped`; E=0; first rearm wins |

## Exclusive deletion receipts

Each symbol appears once and has one disposition. Durable data disposition is explicit: `migrate` preserves rows, `refuse` retains rows and rejects removal, `drop` requires export/backup.

| Child | Production symbol inventory (path:line — disposition) | Dependent test symbol inventory (path — disposition) | Durable data |
|---|---|---|---|
| #969 | `settle`, `deliverWake`, `arm`, `awaitDelegation`, `settleFromReply` in `apps/openomni/src/delegation/kernel.ts:308-783` — move; `settlementWaiters` same file `:130` — delete; `createDelegationKernel` same file `:250-808` and `DelegationDriver.prepare/run` `:41-52` — keep; `executeAwaitDelegation`, `executeCancelDelegation` in `apps/openomni/src/tools/authority/delegation.ts` — keep; `deliver` in `apps/openomni/src/index.ts:435-460` — keep | `admission fold`, `durable kernel`, `delegation controls and tool surface` in `apps/openomni/test/delegation.test.ts:40-624` — keep; `delegation tool boundaries` in `apps/openomni/test/delegation-tool-boundaries.test.ts:51-160` — keep; channel delivery test in `apps/openomni/test/channel-delegation-e2e.test.ts:19` — keep | delegation rows migrate |
| #970 | `createSessionAdmission`, `resumeTurn`, `resumeInterrupted` in `packages/agent/src/session-admission.ts:30-343` — move; `createSessionTurn`, `runTurn` in `packages/agent/src/session-turn.ts:34-411` — move; `runAgent` in `packages/agent/src/core/execution/run.ts:48-` — keep; `serveProcessWorker` and `PROCESS_WORKER_ACK` in `apps/openomni/src/delegation/process-entry.ts:40-84` — keep | `reopened SQLite chooses the correct IDs...` in `packages/agent/test/session-resume-reopen.test.ts:20` — keep; `cancellation at recovered` in `apps/openomni/test/process-session-cancel-race.test.ts:63` — keep | session rows migrate |
| #971 | `sessionStopEvidence` in `packages/agent/src/session-stop-evidence.ts:7-73` — move; `createAlarms` and methods `arm`, `cancel`, `due` in `packages/ledger/src/storage/sqlite-l0-adapter.ts:571-628` — keep; `Alarm` schema in `packages/protocol/src/ledger/l0.ts:508-530` — keep; no evaluator/monitor lifecycle symbol is deleted at HEAD | `positional settlements survive` in `packages/agent/test/session-history.test.ts:12` — keep; no evaluator/monitor test symbol is deleted at HEAD | alarm/occurrence rows migrate; no drop |
| #972 | `sessionHistory` in `packages/agent/src/session-history.ts:6-142` — move; `delivery`, `pendingInbox` in `packages/ledger/src/session/kernel.ts:90-97,238-240` — keep; no legacy projection symbol exists — keep none | `positional settlements survive` in `packages/agent/test/session-history.test.ts:12` — keep | message/part bytes refuse; migrations migrate |
| #973 | no production symbol — keep; no fixture symbol deleted; `session-loop-e2e` test in `apps/openomni/test/session-loop-e2e.test.ts:44` — keep | same named test `real app SSE compaction commits reversible evidence through the session executor` — keep; `reopened SQLite chooses the correct IDs...` in `packages/agent/test/session-resume-reopen.test.ts:20` — keep | none |

## Boundary

Canonical invariants and replay remain in the linked headings above. This delta replaces only independent logical Wait/approval/delivery settlement at #969 cutover; physical channel correlation, provider provenance, alarm rows, and immutable migrations remain.
