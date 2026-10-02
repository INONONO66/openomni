# packages/agent

`@openomni/agent` owns the invocation-scoped chat loop, generic durable-session controller, the compiled-policy L2 executor, and tool definition/dispatch mechanics. Product identity, routing, role policy, and endpoint binding remain in `apps/openomni`.

2026-10-02, #1246: the former `@openomni/policy`, `@openomni/ledger`, and `@openomni/llm` packages fold in here. The policy gate lives in `src/kernel/gate/{compile,match}.ts`; the durable store plane in `src/store/` (`catalog.ts`, `session-file.ts`, `decision.ts`, `fence.ts`, `json.ts`, `atomic-file.ts`, with SQLite adapters under `store/storage/`); the LLM plane in `src/model/` (provider, processor, retry, token, auth, message, model subtrees). The channel-facing stores (actor, blacklist, channel-grant, reply-grant, egress, provisioning/vault) moved to `packages/channels/src/store/`. Everything external imports through the one root barrel `src/index.ts`; there is no second barrel and no re-export file at any old package path. `LedgerFailure`/`LlmFailure` are gone — `AgentFailure` is the single untyped-cause carrier.

2026-09-28, W5.2 #1197: `cluster/session-entity.ts` is the one
`effect/cluster` `SingleRunner` handler per `sessionId`. Activation rotates the
fence, opens the per-session store, drains mailbox FIFO through
`decideSessionAdmission`, and closes the handle on passivation. Retry,
request-deadline, and monitor timing enters through chain-guarded `DeliverAt`
messages; there is no lease, timer, mailbox, or migration persistence plane in
this package.

2026-09-07, #969: `session-request.ts` decides transitions of original actions; `session-requests.ts` obtains session authority and commits them through ledger. Approval re-admission binds the captured invocation, hashes, generations, and domain revisions. `session-outbound.ts` owns durable source obligations; receiving mailbox acknowledgement does not confer cross-session write authority. These are session mechanics, not independent lifecycle stores.

2026-09-08, #972: `session-lifecycle/history.ts` folds model context and `session-lifecycle/inspect.ts` derives diagnostic transitions, policy decisions and commissioned-child traversal from committed actions. Both are pure reads over the ledger tree; `SessionHandle.history()` pages revisions for gap resynchronization. Nothing here writes, replays a body or stores a second history.

## Execution contract

Updated for #937 continuation and W5.2: `session-chat-runner` alone invokes production `runAgent`. Session ownership is split by entity activation, controller lifetime, admission/recovery, running turn, configuration/fence, and durable record projection; none is a second session implementation. `executor-attempts` owns retries and approval re-admission; llm owns failure decisions and usage. `executor-stop` evaluates policy in fixed stop order. Assistant history and reversible compaction projections are durable actions. Native worker assembly shares this loop; it has no separate drive policy.

Every durable `prompt`, `turn`, `llm`, and `tool` operation runs through the per-turn `Executor`, which evaluates the pinned compiled row snapshot and commits a `policy.decision` action per hook. `run()` owns the record for `llm` and `tool`: intent before body, one linked terminal result after, plus a child `attempt` pair per retried model call. `runExisting()` decides over records the session machine already committed, the mailbox action for `prompt` and the turn envelope for `turn`, and appends no second intent or result. Callers do not register policy callbacks. Tool definitions are data plus a body; both model and cell doors use the same executor and output schema.

Observations are lossy projections after durable commits. Session and turn identity come from the session runtime, never tool payloads.

2026-09-09, #945: `turn-assistant` owns synchronous sink folding and assistant persistence; `turn-compaction` owns preparation and application at the existing turn boundaries. Provider stops require an actual assistant snapshot. Session result decoding uses a strict wire schema. Approval request construction and latest-request lookup live in `session-request`; executor approval owns only live waiting and authenticated answers. Observation delivery reports failures through an injected reporter, else as an `observation.delivery_failed` fact on the same sink (runner-free: nothing here logs or throws); a throwing reporter yields both failures in that fact, and a failing failure report is dropped. See `COMPACTION.md` for the provider-boundary invariants.

Updated for #969 request convergence (2026-09-07): `session-request` owns pure request decisions; `session-requests` applies them through the existing fenced session transaction. Approval suspends the original parsed invocation and the whole wave. Product input bindings capture domain preconditions before admission, while authenticated answers and application claims remain executor-owned. `session-chat-runner` recovers original request-bearing waves before model entry; a persisted application claim without a result becomes `outcome_unknown`, never a replay. Both single-call and batch dispatch settle before an interrupted turn seals. There is no separate approval store or model-facing consent decision.

## Boundaries

- Core loop code may depend on protocol and package-local modules only (`src/model/` and `src/kernel/gate/` are package-local since #1246).
- Durable session mechanics may consume the package-local `src/store/` session/action ports.
- No OpenOmni product identity, channel routing, actor grants, or endpoint semantics belong here.
- No callback policy engine, middleware registration, or alternate tool wrapper may be introduced.
- Async tests subscribe to exact state/event signals before triggering and use bounded timeouts only as failure guards.

## Store plane (formerly packages/ledger — key patterns kept, 2026-10-02 #1246)

- `openSessionStore`/`openCatalogStore` are the storage factories; the caller owns and explicitly closes each handle. `SessionHandleStore.createSessionKernel` (`src/store/fence.ts`) binds one session-file handle to the catalog and keeps the fence compare-and-set ownership check.
- Activation rotates the catalog fence exactly once; passivation closes the handle without deleting durable rows. Each session file holds `session`, `action`, `decision_fact`; the catalog holds the session index and cross-session facts. No lease, timer, mailbox, or migration store here.
- Stored JSON decodes into validated plain values before row/domain assembly. No ad-hoc delegated state beside canonical session actions, no second completion/terminal authority, no compatibility readers for old database files.
- Store tests use real SQLite and canonical handle fixtures; corruption is tested at the persisted-data boundary and rollback across the complete write unit.

## Model plane (formerly packages/llm — key patterns kept, 2026-10-02 #1246)

- One attempt per invocation: `run()` performs exactly one Processor attempt (`maxRetries: 0`, `stepCountIs(1)`); the session executor owns attempt scheduling and durable failed-usage records.
- `Llm` (`src/model/services.ts`, tag `@openomni/agent/Llm`) exposes `{ run, resolveModel }`; `LlmLive` is the app-composed Layer. Retry is classification, not scheduling (`Retry.decide`, caps: 60s explicit directive, 30s headerless with jitter; billing and content_policy are terminal).
- Usage accounting is provider-plus-local with `reported | estimated | unknown` provenance; a reported numeric 0 is authoritative. Auth storage writes atomically at mode 0600 and never reads env — the credential path is injected (#1245).
- Do NOT import `Bus` in model code (injected `events` sink only), add provider-specific logic at call sites, or reintroduce `Retry.sleep`/`maxSteps`/zero-defaulted usage counts.
- `src/` keeps the consumer lib floor: never raise `lib` in `tsconfig.json` (model sources must check under ES2020; the test tree runs at ES2022 via `tsconfig.test.json`).
- Tests run Effects only through the package runner owner `test/helpers/isolated.ts`; `test/model/helpers/native.ts` and `test/store/helpers/effect.ts` delegate to it.
