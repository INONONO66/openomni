# subagent/

Session-backed subagent execution runtime for the openomni orchestration layer.

## Files

| File | Role | Exported |
|------|------|----------|
| `runtime.ts` | `SubagentRuntime` — orchestration shell for spawn / send / resume / cancel / wait backed by `WorkerRun` records | yes |
| `consultation.ts` | `SubagentConsultation` — one-shot synchronous subagent calls (request/response pattern) | yes |
| `background-manager.ts` | `BackgroundManager` — fire-and-forget wrapper with concurrency and depth limits | yes |
| `background-store.ts` | `BackgroundStore` — in-memory registry of active background runs | yes |
| `shared.ts` | `RuntimeModel`, `RuntimeMessage` types and message factory helpers (parameterized agent field) | no |
| `message-builder.ts` | Message construction and serialization for subagent communication | no |
| `run-lifecycle.ts` | Abort, timeout, and finalize functions for `WorkerRun` lifecycle | no |
| `transcript.ts` | Compaction bridge and `runWithTranscript` (imports from `@openomni/agent` barrel, no relative cross-package imports) | no |
| `session-lock.ts` | `withSessionLock` wrapper — prevents concurrent writes to the same session | no |
| `session-mailbox.ts` | Mailbox abstraction for queued message delivery to a session | no |
| `abort-registry.ts` | Global registry mapping run IDs to abort controllers | no |

## Module Split Rationale

`runtime.ts` was refactored from ~1094 LOC into focused modules. The split follows single-responsibility: each internal module owns one concern (types, message construction, lifecycle, transcript, locking). Only the four public classes are re-exported from `index.ts`; the rest are internal implementation details.

Internal modules (`shared.ts`, `message-builder.ts`, `run-lifecycle.ts`, `transcript.ts`, `session-lock.ts`, `session-mailbox.ts`, `abort-registry.ts`) are not exported from the barrel. Import them only from within this domain.

## Dependencies

- `@openomni/agent` (barrel only — no relative cross-package imports)
- `@openomni/session`
- `@openomni/protocol`
- `../execution-runtime/` for tool system and workspace lock
