# packages/agent

`@openomni/agent` owns the invocation-scoped chat loop, generic durable-session controller, the compiled-policy L2 executor, and tool definition/dispatch mechanics. Product identity, routing, role policy, and endpoint binding remain in `apps/openomni`.

## Execution contract

Every durable `prompt`, `turn`, `llm`, and `tool` operation runs through the per-turn `Executor`, which evaluates the pinned compiled row snapshot and commits a `policy.decision` action per hook. `run()` owns the record for `llm` and `tool`: intent before body, one linked terminal result after, plus a child `attempt` pair per retried model call. `runExisting()` decides over records the session machine already committed, the inbox action for `prompt` and the turn envelope for `turn`, and appends no second intent or result. Callers do not register policy callbacks. Tool definitions are data plus a body; both model and cell doors use the same executor and output schema.

Observations are lossy projections after durable commits. Session and turn identity come from the session runtime, never tool payloads.

## Boundaries

- Core loop code may depend on protocol, llm, placement, and package-local modules.
- Durable session mechanics may consume ledger-owned session/action ports.
- No OpenOmni product identity, channel routing, actor grants, or endpoint semantics belong here.
- No callback policy engine, middleware registration, or alternate tool wrapper may be introduced.
- Async tests subscribe to exact state/event signals before triggering and use bounded timeouts only as failure guards.
