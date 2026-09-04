// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { RunReasonCode } from "./core/policy/reason-codes";
export { failureFacts } from "./core/retry";
export { placementGatedExecutor } from "./core/execution/turn";
export { createCompactionPolicy } from "./compaction";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { closeSessions, session, sweepSessions } from "./session-handle";
export { createExecutor } from "./executor";
export type {
  ExecutionIdentity,
  ExecutionLedger,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  ExecutorOptions,
} from "./executor";
export {
  createDispatcher,
  defineTool,
  eraseTool,
  MODEL_OUTPUT_MAX_CHARS,
  toolInputSchema,
} from "./tool-dispatcher";
export type {
  CellToolDispatchResult,
  Dispatcher,
  DispatcherOptions,
  ToolDispatchResult,
  ToolErrorKind,
  ToolExecutionCommitter,
  ToolExecutionObservation,
  ToolPostInput,
  ToolPostPolicy,
  ToolPostResult,
} from "./tool-dispatcher";
export {
  Bus,
  collector,
  createObservationBus,
  newTraceId,
  noopObservationSink,
  noopSink,
  observationCollector,
  scope,
  scopeObservation,
} from "./observation/bus";
export type {
  CollectingObservationSink,
  ObservationBus,
  ScopeObservationOptions,
} from "./observation/bus";
export type {
  SessionHandle,
  SessionRunner,
  SessionRunnerInput,
  SessionRunnerResult,
  SessionRuntime,
} from "./session-handle";
