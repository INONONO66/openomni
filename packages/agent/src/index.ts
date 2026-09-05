// Agent package public API: only surfaces consumed by product composition.
export type { AgentExecutionLifecycle, ChatAgentConfig } from "./core/types";
export { RunReasonCode } from "./core/policy/reason-codes";
export { failureFacts } from "./core/retry";
export { placementGatedExecutor } from "./core/execution/turn";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { closeSessions, session, sweepSessions } from "./session-handle";
export { createExecutor, UnregisteredExecutionKindError } from "./executor";
export { SEEDED_POLICY_ROWS } from "@openomni/policy";
export type { ExecutionLedger, Executor } from "./executor";
export {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  eraseTool,
  ExecutorContextError,
  HOST_TARGET,
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
