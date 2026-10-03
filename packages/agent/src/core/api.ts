// The single import target for capability plugins (#1276): re-exports exactly
// the core ports and types `plugins/compaction` consumes today. #1255 grows
// this into the core context handed to loaded capabilities.
export type { ExecutionRequest, Executor } from "./gate/decide";
export {
  AgentFailure, AgentInvariantViolation, CompactionExecutionError, ContextRestoreError,
  type ExecutionError,
} from "./failure";
export type { SessionKernel } from "./entity";
export { Entropy } from "./ports";
export { RunEvents } from "./run-events";
