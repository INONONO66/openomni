# packages/placement

Ring-1 pure target-selection package (docs/architecture.md § Outbound target selection), opened by #752 with its smallest honest slice: the MODEL axis. `Placement.selectModel(chain, priorFailureReasons)` folds an ordered model-candidate chain and the run's decided failure history into the next attempt's model — a pure decision in the protocol-fold discipline (no clock, no store, no I/O; deterministic and replayable).

## SEMANTICS

- Chain-advancing failure classes: `timeout`, `transient_error`, `validation_error` (provider/model-specific faults — the point of a fallback chain).
- Never advancing: `tool_error` (not the model's fault), `context_overflow` (the compaction recovery seam retries the SAME model — advancing would fight it), `aborted` (a stop instruction is never a placement signal), and unknown strings (fail conservative).
- Selection clamps to the last candidate and reports `exhausted` — WHEN a run stops retrying stays the retry policy's decision; placement only picks.
- The reason vocabulary is the agent loop's `TerminalReason` strings; placement deliberately does not import the loop — the coupling is by declared string, pinned by tests on both sides.

## BOUNDARIES

- Depends on `@openomni/protocol` only (`Model.Ref`) — enforced by `script/check-deps.ts`.
- Decides placement ONLY: policy alone owns allow/deny, admission alone closes work, retry policy alone terminates. The selection result is consumed as an input.
- Capability-tag/machine placement (the executor axis) is a later slice; do not grow it here without its own roadmap leaf.

## CONSUMERS

`packages/agent` — `runAgent` resolves the model per retry attempt through this fold when `ChatAgentConfig.modelFallbacks` is configured (the chain is `[config.model, ...modelFallbacks]`; the failure history is the loop's decided `RunFailureFacts.reason` values, never re-derived).

## TESTS

`bun test` in this package: advancing/non-advancing classes, clamping + exhaustion, mixed histories, determinism, empty-chain refusal.
