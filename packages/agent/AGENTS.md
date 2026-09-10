# packages/agent

`@openomni/agent` owns the invocation-scoped chat loop, generic durable-session controller, the compiled-policy L2 executor, and tool definition/dispatch mechanics. Product identity, routing, role policy, and endpoint binding remain in `apps/openomni`.

2026-09-07, #969: `session-request.ts` decides transitions of original actions; `session-requests.ts` obtains session authority and commits them through ledger. Approval re-admission binds the captured invocation, hashes, generations, and domain revisions. `session-outbound.ts` owns durable source obligations; receiving inbox acknowledgement does not confer cross-session write authority. These are session mechanics, not independent lifecycle stores.

2026-09-08, #972: `session-lifecycle/history.ts` folds model context and `session-lifecycle/inspect.ts` derives diagnostic transitions, policy decisions and commissioned-child traversal from committed actions. Both are pure reads over the ledger tree; `SessionHandle.history()` pages revisions for gap resynchronization. Nothing here writes, replays a body or stores a second history.

## Execution contract

Updated for #937 continuation (2026-09-06): `session-chat-runner` alone invokes production `runAgent`. Session ownership is split by registry/handle, controller lifetime, admission/recovery, running turn, configuration/lease, and durable record projection; none is a second session implementation. `executor-attempts` owns retries and approval re-admission; llm owns failure decisions and usage. `executor-stop` evaluates policy in fixed stop order. Assistant history and reversible compaction projections are durable actions. Native worker assembly shares this loop; it has no separate drive policy.

Every durable `prompt`, `turn`, `llm`, and `tool` operation runs through the per-turn `Executor`, which evaluates the pinned compiled row snapshot and commits a `policy.decision` action per hook. `run()` owns the record for `llm` and `tool`: intent before body, one linked terminal result after, plus a child `attempt` pair per retried model call. `runExisting()` decides over records the session machine already committed, the inbox action for `prompt` and the turn envelope for `turn`, and appends no second intent or result. Callers do not register policy callbacks. Tool definitions are data plus a body; both model and cell doors use the same executor and output schema.

Observations are lossy projections after durable commits. Session and turn identity come from the session runtime, never tool payloads.

2026-09-09, #945: `turn-assistant` owns synchronous sink folding and assistant persistence; `turn-compaction` owns preparation and application at the existing turn boundaries. Provider stops require an actual assistant snapshot. Session result decoding uses a strict wire schema. Approval request construction and latest-request lookup live in `session-request`; executor approval owns only live waiting and authenticated answers. Observation delivery reports failures through an explicit error sink and retains both failures if its reporter throws. See `COMPACTION.md` for the provider-boundary invariants.

Updated for #969 request convergence (2026-09-07): `session-request` owns pure request decisions; `session-requests` applies them through the existing fenced session transaction. Approval suspends the original parsed invocation and the whole wave. Product input bindings capture domain preconditions before admission, while authenticated answers and application claims remain executor-owned. `session-chat-runner` recovers original request-bearing waves before model entry; a persisted application claim without a result becomes `outcome_unknown`, never a replay. Both single-call and batch dispatch settle before an interrupted turn seals. There is no separate approval store or model-facing consent decision.

## Boundaries

- Core loop code may depend on protocol, llm, policy, and package-local modules.
- Durable session mechanics may consume ledger-owned session/action ports.
- No OpenOmni product identity, channel routing, actor grants, or endpoint semantics belong here.
- No callback policy engine, middleware registration, or alternate tool wrapper may be introduced.
- Async tests subscribe to exact state/event signals before triggering and use bounded timeouts only as failure guards.
