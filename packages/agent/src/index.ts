// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { createSessionRequests } from "./session-requests";
export { decideRequestTransition, requestBindingDigest } from "./session-request";
export { decideSessionAdmission, requestAuthorityKernel } from "./session-admission";
export { failureFacts } from "./core/retry";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { closeSessions, session } from "./session-handle";
export { createSessionEntityRunTurn } from "./session-controller";
export { createExecutor, ExecutionApprovalError } from "./executor";
export * from "./errors";
export * from "./services";
export * from "./bundle";
export { AgentProcessLive } from "./layers";
export { ExecutorContext, executorContext, ExecutorContextError, currentInvocation, forkInvocation } from "./executor-context";
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
// W5.2 #1197 cluster surface (plan F6): the Session entity and its composition seams.
export { SessionEntity, SessionEntityContext, SessionEntityLive } from "./cluster/session-entity";
export {
  deadlineDelivery,
  retryDelivery,
  watchFiredDelivery,
  watchTimeoutDelivery,
  type TimerChainReads,
} from "./cluster/timers";
export type {
  SessionEntityPorts,
  SessionEntityTimerContext,
  SessionEntityTurnInput,
} from "./session-contract";
export { Bus, createObservationBus, newTraceId, scopeObservation } from "./observation/bus";
export type { SessionHandle, SessionRunner, SessionRuntime } from "./session-handle";
