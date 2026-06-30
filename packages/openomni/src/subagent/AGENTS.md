# subagent/

Session-backed subagent execution runtime for the OpenOmni workforce kernel.

`@openomni/agent` may own the generic `SubagentTool` contract and delegation safety primitives. This directory owns the OpenOmni-specific durable runtime: child sessions, WorkerRun records, background task lifecycle, admission policy, cancellation, wait/resume semantics, and transcript projection.

## Files

| File | Role | Exported |
|------|------|----------|
| `runtime.ts` | `SubagentRuntime` — orchestration shell for spawn / send / resume / cancel / wait backed by `WorkerRun` records | yes |
| `consultation.ts` | `SubagentConsultation` — one-shot synchronous subagent calls (request/response pattern) | yes |
| `background-manager.ts` | `BackgroundManager` — fire-and-forget wrapper with concurrency and depth limits | yes |
| `background-store.ts` | `BackgroundStore` — in-memory registry of active background runs | no |
| `shared.ts` | `RuntimeModel`, `RuntimeMessage` types and message factory helpers (parameterized agent field) | no |
| `message-builder.ts` | Message construction and serialization for subagent communication | no |
| `run-lifecycle.ts` | Abort, timeout, and finalize functions for `WorkerRun` lifecycle | no |
| `runtime-admission.ts` | Parent-scoped delegation admission, child runtime policy summary, and child-run middleware assembly | no |
| `runtime-cancel.ts` | Cancel orchestration for active or explicit worker runs | no |
| `runtime-wait.ts` | Event-driven wait orchestration and `WorkerRun` output projection | no |
| `transcript.ts` | Compaction bridge and `runWithTranscript` (imports from `@openomni/agent` barrel, no relative cross-package imports) | no |
| `session-mailbox.ts` | Mailbox abstraction for queued message delivery to a session | no |
| `abort-registry.ts` | Global registry mapping run IDs to abort controllers | no |

## Module Split Rationale

`runtime.ts` was refactored from ~1094 LOC into focused modules. The split follows single-responsibility: each internal module owns one concern (types, message construction, lifecycle, transcript, mailbox delivery). Only runtime-facing classes and middleware are re-exported from `index.ts`; the rest are internal implementation details.

Internal modules (`background-store.ts`, `shared.ts`, `message-builder.ts`, `run-lifecycle.ts`, `runtime-admission.ts`, `runtime-cancel.ts`, `runtime-wait.ts`, `transcript.ts`, `session-mailbox.ts`, `abort-registry.ts`) are not exported from the barrel. Import them only from within this domain.

## Boundary Rules

- Keep session-backed lifecycle here, not in `packages/agent`.
- Use `@openomni/session` for durable records, but keep orchestration semantics here: admission, status transitions, cancellation decisions, wait behavior, and output projection are OpenOmni responsibilities.
- Do not add raw channel, PendingInteraction/PendingAsk, actor trust, or external actor routing logic here unless it is part of a worker/subagent lifecycle handoff owned by the communication kernel.
- Do not bypass the OpenOmni authority/communication stages when a subagent operation crosses sessions, workers, or external actors.
- Background task persistence may use session storage, but lifecycle semantics and result shaping stay in this domain.

## Dependencies

- `@openomni/agent` (barrel only — no relative cross-package imports)
- `@openomni/session`
- `@openomni/protocol`
- `../execution-runtime/` for tool system and workspace lock
