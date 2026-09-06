# Unified session lifecycle and transition ownership

**Status: target design freeze for #968; current behavior is marked _shipped_.** This document is the contract that #969-#973 implement and test. It does not introduce another engine, policy evaluator, approval system, watcher, WorkItem, or Attempt domain.

## 1. State set

A session has one durable identity (`id`, `role`, `parentId`) and one durable scalar lifecycle: `idle | running | interrupted` (_shipped_: `packages/protocol/src/ledger/l0.ts:79-80`). Its durable row also carries revision, fenced lease owner/fence/expiry, and latest generation pointers (_shipped_: `packages/protocol/src/ledger/l0.ts:82-103`). The action tree is append-only; the row is an operational projection, not a second history (_shipped_: `packages/agent/src/session-history.ts:5-14`).

The complete target state is a product, not a giant enum:

* **Lifecycle:** `idle`, `running`, `interrupted`; each turn has `open -> result | waiting | interrupted | error` and is identified by `turnId` plus pre-minted `resultId` (_shipped_: `packages/agent/src/session-contract.ts:79-105`; _shipped_: `packages/agent/src/session-admission.ts:73-99`).
* **Residency lease:** `free` or `held(fence, owner, expiry)`, with fenced single-flight ownership. A stale fence cannot commit (_shipped_: `packages/agent/src/session-contract.ts:124-134`; _shipped_: `packages/agent/src/session-admission.ts:216-243`).
* **Intake/scheduling:** inbox rows `prompt | interrupt | resume`; pending rows are consumed exactly by a commit, and at most one controller drive is active (_shipped_: `packages/agent/src/session-controller.ts:205-253`).
* **Operation/effect:** each model/tool/policy operation has `pre -> intent? -> approval? -> body -> result`, with terminals `executed`, `blocked_pre`, `cancelled`, or `failed`; waves preserve positional output and sequential barriers (_shipped_: `packages/agent/src/executor.ts:148-173`, `:174-215`, `:217-273`).

Approval is a nonterminal suspension of the original operation: the original intent and its policy generation remain pinned while approval resolves (_shipped_: `packages/agent/src/executor.ts:174-198`). It is never generic interrupt/resume and never reconstructs a model invocation. Whole-wave gating is normative target: all pre-verdicts first; no body starts while any required approval is pending. Refusal/timeout blocks only that call; interrupt cancels the wave.

History projection is read-only reconstruction: it folds committed actions, assistant messages, compaction projections, and tool results; it never re-executes an open call (_shipped_: `packages/agent/src/session-history.ts:45-90`, `:124-141`). Provider attempts remain provider/LLM evidence, not session lifecycle state; no WorkItem/Attempt revival (_shipped_: `packages/agent/src/core/execution/run.ts:47-57`, `:116-120`).

## 2. Transition ownership

Every transition has exactly one owner. Validation, durable commit, and effect dispatch are separate phases; replay performs validation/fold only and dispatches zero effects.

| Region | Legal transition/product | Sole owner | Not owned here |
|---|---|---|---|
| lifecycle | create `absent -> idle`; `idle -> running`; `running -> idle`; `running -> interrupted`; `interrupted -> running`; open turn -> one terminal | **Session admission/turn authority** (`session-admission.ts` + `session-turn.ts`) | drivers, UI, bus, history projection |
| residency-lease | acquire/takeover, heartbeat renewal, fenced commit, release/hibernate | **Session handle/controller + ledger session kernel** | runner, worker transport, watcher |
| intake-scheduling | append prompt/interrupt/resume; consume inbox; serialize drive; wake/reconcile | **Session handle/controller** | callers changing row state directly, bus as queue |
| operation-effect | policy pre/post decision; append intent/result; approval request/answer/timeout; body dispatch; wave cancellation | **Agent executor** | session scalar lifecycle, transport drivers, approval UI |

The session controller wires the owners but does not duplicate their folds (_shipped_: `packages/agent/src/session-controller.ts:46-90`). A terminal CAS winner is the only winner; late, duplicate, stale-fence, and invalid transitions fail closed. Events and watchers are after-commit observations, never authority.

## 3. Legal transition table and precedence

| Pre-state | Input/race | Result | CAS/effect rule |
|---|---|---|---|
| `idle` | prompt admitted with live lease | `running`, open turn | commit inbox consumption + turn intent before runner effect (_shipped_: `packages/agent/src/session-admission.ts:58-99`) |
| `running` | interrupt | `interrupted`, then terminal interrupt | interrupt row/row transition wins; abort effect; no late result may seal (_shipped_: `packages/agent/src/session-controller.ts:222-239`; _shipped_: `packages/agent/src/session-admission.ts:101-120`) |
| `running` | runner returns result/wait/error | corresponding terminal | first fenced seal wins; duplicate or stale seal is rejected (_shipped_: `packages/agent/src/session-admission.ts:216-243`) |
| `interrupted` | resume after terminal interrupt | new `turnId`, new `resultId`, latest generation | terminal interrupt never reuses execution IDs; target invariant |
| crash-open | recovery | same `turnId`, same `resultId`, pinned generation; resume action increments bounded count | recovery must not replay settled effects; _shipped_ resume path: `packages/agent/src/session-admission.ts:247-295` |
| any | approval required | operation remains pending | no wave body until all pre approvals resolve (_shipped_: `packages/agent/src/executor.ts:174-215`) |
| approval pending | approve | original operation body | same intent/generation; no reconstruction |
| approval pending | refuse/timeout | `blocked_pre` for that call | siblings admitted in original order may proceed (_shipped_: `packages/agent/src/executor.ts:232-247`) |
| wave active | interrupt | all uncompleted effects cancelled | cancellation result is recorded; no unrecorded body (_shipped_: `packages/agent/src/executor.ts:217-231`) |
| open operation | late reply/duplicate result | existing terminal unchanged | terminal CAS winner only; target invariant |

Precedence is: durable terminal CAS > stale-fence refusal > interrupt cancellation > approval refusal/timeout > ordinary result. A timeout at its deadline beats a late reply if its CAS commits first; a reply that wins first remains the terminal. “Unknown outcome” is retained for crash/transport expiry; no exactly-once external-effect claim.

## 4. Current shipped boundaries

Native workers use the same session-owned loop and session id as the delegation id (_shipped_: `apps/openomni/src/composition/worker-session.ts:128-156`, `:159-184`). They do not run a second drive loop; a waiting worker watches the existing handle terminal (_shipped_: `apps/openomni/src/composition/worker-session.ts:220-248`). The delegation kernel alone settles durable delegation records by CAS, then publishes and wakes after commit (_shipped_: `apps/openomni/src/delegation/kernel.ts:303-346`). Its deadline timer, restart matrix, cancellation, and correlated reply are separate delegation residency/transport concerns (_shipped_: `apps/openomni/src/delegation/kernel.ts:382-439`, `:754-783`).

Session history is canonical action projection, not legacy message/part authority (_shipped_: `packages/agent/src/session-history.ts:5-9`, `:124-141`). The implementation-status page says durable handles and native worker binding are wired (_shipped_: `docs/implementation-status.md:19-20`, `:32-32`); this document freezes the remaining cross-cutting target and does not alter that shipped-state claim.

## 5. Child issue construction and deletion receipts

### #969 — waiting and delivery under actions

**May change:** move generic request waiting/delivery decisions into the operation/intake action tree, retaining necessary channel correlation and physical drivers. Define action-backed request/reply occurrence IDs, deadlines, late/duplicate handling, and replay projection.

**May not change:** session identity, turn ID rules, lease fencing, executor approval semantics, policy compilation, or delegation settlement authority. It must not create a second Wait/session machine.

**Must delete:** independent Wait/Approval/delivery lifecycle authority, duplicate pending-request state machines, delivery branches that decide terminal truth outside the canonical action owner, and any compatibility adapter/dual path after cutover. Retain the physical channel driver and only the correlation primitive it demonstrably needs.

### #970 — durable recovery, retry, restoration

**May change:** recovery decisions, bounded resume/retry, typed restoration and generation pinning in the existing admission/turn owner; add crash/race traces.

**May not change:** terminal interrupt ID regeneration versus crash-open ID reuse, operation effect ownership, external exactly-once claims, or introduce rollback.

**Must delete:** independent recovery/retry authority, process-local restoration truth, generic replay of provider/tool effects, and WorkItem/Attempt replacement rows or aliases.

### #971 — monitor occurrences and evaluator recovery

**May change:** represent monitor/evaluator occurrences as operation actions and align their recovery/terminal observations with session transitions.

**May not change:** lifecycle/lease CAS ownership, watcher truth, policy-engine count, or operation body ordering.

**Must delete:** monitor-specific lifecycle state machine, evaluator-owned recovery decisions that bypass session admission, duplicate terminal watchers, and any polling/sleep-based bridge.

### #972 — action-based history and diagnostics

**May change:** projections and causal diagnostics over append-only actions, including request/reply/approval/monitor occurrence IDs.

**May not change:** canonical action writes, transition legality, effect dispatch, or legacy-byte retention/disposition without the required archive/retention decision.

**Must delete:** history authority in legacy message/part or delivery tables, duplicate JSON/event histories, and projection paths that execute effects. Keep only independently consumed physical storage until verified disposition.

### #973 — conformance and semantic deletion

**May change:** model/property harnesses and real-surface tests proving invalid transitions fail closed, one terminal winner, deterministic zero-effect replay, mixed-wave gating/order, recovery, and deletion census.

**May not change:** production semantics or add test-only alternate authorities, sleeps, timing luck, or phrase-pinned prose tests.

**Must delete:** obsolete fixtures and tests encoding deleted WorkItem/Attempt, independent Wait/Approval/delivery state, second watchers, or dual-path compatibility. The deletion receipt must name source consumers and prove no surviving reader/writer.

## 6. Non-negotiable invariants

1. One durable session history and one transition authority.
2. Intent before effect; replay folds without dispatch.
3. One fenced single-flight session lease; stale writers cannot commit.
4. Interrupt cancels the current execution and uses new IDs on later execution; crash recovery resumes the same IDs and pinned generation.
5. Approval suspends the original parsed invocation; whole-wave pre-gating prevents body effects while waiting.
6. Bus/watchers are lossy observations after commit, never truth or command queues.
7. No WorkItem/Attempt revival, second kernel/policy/approval/watcher, compatibility adapter, or dual path.
8. Provider attempts and external effects are historical evidence; no universal rollback or exactly-once external-effect guarantee.
