// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { createSessionRequests } from "./session-requests";
export { decideRequestTransition, requestBindingDigest } from "./session-request";
export { failureFacts } from "./core/retry";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { foldSessionHistory } from "./session-lifecycle/history";
export { inspectActions, inspectPolicy } from "./session-lifecycle/inspect";
export {
  closeSessions,
  getSessionHandle,
  session,
  sweepSessions,
  wakeSession,
} from "./session-handle";
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
export { Bus, createObservationBus, newTraceId, scopeObservation } from "./observation/bus";
export type {
  SessionHandle,
  SessionRunner,
  SessionRunnerInput,
  SessionRuntime,
} from "./session-handle";
