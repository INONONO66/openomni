# packages/placement

Ring-1 pure target-selection package (docs/architecture.md § Outbound target selection). `Placement.selectModel(chain, priorFailureReasons)` folds an ordered model-candidate chain and decided failure history into the next model. `Placement.resolveTools(tools, targets)` folds a tool catalog and caller-supplied host/machine effective capability sets into per-tool offerability decisions (total: an empty target list means nothing is offerable, not an error). Which eligible machine executes a tool is named by the caller (a `run_code` cell takes a `machineId`, discovered via the `machines` catalog tool) and is deliberately absent here. Both are pure protocol-fold decisions (no clock, no store, no I/O; deterministic and replayable).

## SEMANTICS

- Chain-advancing failure classes: `timeout`, `transient_error`, `validation_error` (provider/model-specific faults — the point of a fallback chain).
- Never advancing: `tool_error` (not the model's fault), `context_overflow` (the compaction recovery seam retries the SAME model — advancing would fight it), `aborted` (a stop instruction is never a placement signal), and unknown strings (fail conservative).
- Selection clamps to the last candidate and reports `exhausted` — WHEN a run stops retrying stays the retry policy's decision; placement only picks. (The agent loop makes `validation_error` retryable ONLY while a fallback chain is configured — a refusal reaches a different model, never a blind same-model retry.)
- The reason vocabulary is the agent loop's `TerminalReason` strings; placement deliberately does not import the loop — the coupling is by declared string, cross-pinned by `packages/agent/test/core/placement-vocabulary.test.ts` (compile-time exhaustiveness over `RetryReason` + runtime set equality; a rename on either side fails there, not silently).
- Tool placement reads absent `Tool.Spec.placement` as `free` in exactly one place, and requires one candidate to hold the complete `requires` subset (never pooled across candidates). Effective sets come from protocol's `Machine.effectiveCapabilities`; placement never repeats enrollment/offer negotiation.

## BOUNDARIES

- Depends on `@openomni/protocol` only (`Model.Ref`, `Tool.Spec`, and `Machine` identities/capabilities) — enforced by `script/check-deps.ts`.
- Decides placement ONLY: policy alone owns allow/deny, admission alone closes work, retry policy alone terminates. Selection results are consumed as inputs.
- Capability negotiation and attachment state stay outside this package; callers supply effective facts.

## CONSUMERS

`packages/agent` — `runAgent` resolves the model per retry attempt through the model fold. `buildTurn` resolves the configured catalog through the machine fold before `tool.catalog.pre`, prompt tool fragments, and the llm seam, and gates execution with the same decisions so a forged call to a filtered tool is refused instead of executed; `ChatAgentConfig.toolTargets` carries the effective capability facts.

## TESTS

`bun test --timeout 15000` in this package: model advancing/non-advancing classes, clamping + exhaustion, mixed histories, and empty-chain refusal; tool placement × requirements, unknown capabilities, complete-subset matching (never pooled across candidates), host/machine non-substitution, catalog-order determinism, and the empty-target fold.
