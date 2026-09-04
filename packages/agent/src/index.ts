// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { RunReasonCode } from "./core/policy/reason-codes";
export { failureFacts } from "./core/retry";
export { placementGatedExecutor } from "./core/execution/turn";
export { createCompactionPolicy } from "./compaction";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { closeSessions, session, sweepSessions } from "./session-handle";
export type {
  SessionHandle,
  SessionRunner,
  SessionRunnerInput,
  SessionRunnerResult,
  SessionRuntime,
} from "./session-handle";
