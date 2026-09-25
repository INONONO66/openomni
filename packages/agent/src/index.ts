// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { createSessionRequests } from "./session-requests";
export { decideRequestTransition, requestBindingDigest } from "./session-request";
export { failureFacts } from "./core/retry";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export {
  closeSessions,
  getSessionHandle,
  session,
  sweepSessions,
  wakeSession,
} from "./session-handle";
export { createExecutor, ExecutionApprovalError } from "./executor";
export * from "./errors";
export * from "./services";
export * from "./bundle";
export { AgentGenerationLive, AgentProcessLive } from "./layers";
export { ExecutorContext, executorContext, ExecutorContextError, currentInvocation, requireOpenInvocation, forkInvocation } from "./executor-context";
export type { InvocationFrame } from "./executor-context";
export { makeSessionGenerations } from "./session-generations";
export type { GenerationBundle } from "./session-generations";
export type { ExecutionApprovalRequest } from "./executor";
export { SEEDED_POLICY_ROWS } from "@openomni/policy";
export type { Executor } from "./executor";
export {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  eraseTool,
  sessionTool,
  ToolRefused,
  toolInputSchema,
  toolSpec,
} from "./tool-dispatcher";
export type { ToolDispatchDefinition } from "./tool-dispatcher";
export { Bus, createObservationBus, newTraceId, scopeObservation } from "./observation/bus";
export type { SessionHandle, SessionRunner, SessionRuntime } from "./session-handle";
