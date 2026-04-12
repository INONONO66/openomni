# Team Mode

Deterministic step dispatch loop that executes Plan Mode output. Given a `Plan` (ordered steps with dependencies), Team Mode walks the DAG, assigns each ready step to a Teammate agent, reviews the result, and advances until all steps complete or a stall is detected.

## Modules

| File | Role |
|------|------|
| `team-orchestrator.ts` | Main dispatch loop. Reads DAG for ready steps, dispatches to Teammate, feeds results through ReviewLoop, updates RunLedger. Emits Team bus events throughout. |
| `teammate.ts` | Dispatches a step to an agent. When `subagentRuntime` is injected, reuses persistent worker sessions via `SubagentRuntime.spawn/send`; otherwise falls back to a fresh `ChatAgent` per call. Merges config-level and step-level tools (step takes precedence). |
| `review-loop.ts` | LLM-based accept/reject gate. Sends step output + expected output to a reviewer agent. On reject, optionally generates a handoff document for the next attempt. |
| `run-ledger.ts` | Step state tracker with optional EventLog-backed persistence. Manages `ready -> running -> succeeded/failed/retrying/handed_off` transitions, attempt counts, and rejection streaks. When bound to a session via `sessionId`, persists transitions to EventLog and supports `RunLedger.recover()` for crash recovery. |
| `stall-detector.ts` | Detects three stall conditions: consecutive rejections (step keeps failing review), unsatisfiable dependencies (step depends on a failed/skipped step), and no-progress (no steps advancing for N turns). |
| `approval-gate.ts` | Human-in-the-loop gate. Publishes `ApprovalRequested` bus event and blocks until `respond()` is called or timeout elapses. Default timeout: 5 minutes, then auto-reject. |
| `evaluation-gate.ts` | Lightweight heuristic quality check. Scores actual vs expected output using word-overlap similarity. Alternative to LLM-based ReviewLoop when a fast, deterministic check suffices. |

## Ledger Semantics

RunLedger tracks per-step state (`ready`, `running`, `succeeded`, `failed`, `skipped`, `retrying`, `handed_off`), attempt count, and rejection streak. State transitions are validated against a transition table; invalid transitions throw. The ledger returns defensive copies from all read methods to prevent external mutation. When created with a `sessionId`, each transition is appended to EventLog for durable persistence; `RunLedger.recover(sessionId, steps)` replays the log to reconstruct state after a restart.

## Stall Recovery

StallDetector runs three checks in priority order:
1. **Consecutive rejections** -- a step's rejection streak exceeds the configured limit.
2. **Unsatisfiable deps** -- a step's dependency is in `failed` or `skipped` state.
3. **No progress** -- no steps have advanced for N turns and nothing is currently running.

When a stall is detected, the orchestrator decides recovery action (skip step, fail run, etc.) based on the `StallReason` returned.

## Relationship to DAG and Plan Mode

Plan Mode (`PlanAgent`) generates a `Plan` with steps and dependency edges. The DAG module (`src/dag/`) builds and validates the dependency graph. Team Mode consumes both: it uses the DAG to determine which steps are ready (all dependencies satisfied) and dispatches them through the orchestrator loop.
