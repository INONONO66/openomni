// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { failureFacts } from "./core/retry";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { closeSessions, getSessionHandle, session, sweepSessions, wakeSession } from "./session-handle";
export { createExecutor, ExecutionApprovalError, UnregisteredExecutionKindError } from "./executor";
export { SEEDED_POLICY_ROWS } from "@openomni/policy";
export type {
  ExecutionLedger,
  Executor,
  ExecutionApprovalRequest,
} from "./executor";
export {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  eraseTool,
  ExecutorContextError,
  sessionTool,
  ToolRefused,
  toolInputSchema,
  toolSpec,
} from "./tool-dispatcher";
export {
  Bus,
  collector,
  createObservationBus,
  newTraceId,
  noopSink,
  scopeObservation,
} from "./observation/bus";
export type {
  SessionHandle,
  SessionRunner,
  SessionRunnerInput,
  SessionRunnerResult,
  SessionRuntime,
} from "./session-handle";
