// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./core/types";
export { createSessionRequests } from "./session-requests";
export { adoptSessionAuthority } from "./session-configuration";
export { receivedMessageAction } from "./session-record";
export { decideRequestTransition, requestBindingDigest } from "./session-request";
export { decideSessionAdmission, requestAuthorityKernel } from "./session-admission";
export { failureFacts } from "./core/retry";
export * as Failure from "./failure";
export type { CompactionOptions } from "./compaction";
export { createSessionChatRunner } from "./session-chat-runner";
export { attemptUsage, toolWallMs } from "./session-lifecycle/metrics";
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
export { SEEDED_POLICY_ROWS } from "./kernel/gate/compile";
export type { Executor } from "./executor";
export { createDispatcher, createTurnDispatcher, currentExecutor, defineTool, eraseTool, sessionTool, ToolRefused, toolInputSchema, toolSpec, } from "./tool-dispatcher";
// W5.2 #1197 cluster surface (plan F6): the Session entity and its composition seams.
export { SessionEntity, SessionEntityContext, SessionEntityLive } from "./cluster/session-entity";
export { deadlineDelivery, retryDelivery, watchFiredDelivery, watchTimeoutDelivery, type TimerChainReads, } from "./cluster/timers";
export type { SessionEntityPorts, SessionEntityTimerContext, SessionEntityTurnInput, } from "./session-contract";
export { createObservationBus, scopeObservation } from "./observation/bus";
export type { SessionHandle, SessionRunner, SessionRuntime } from "./session-handle";
// #1246: policy, ledger and llm fold into agent; externals import these names
// from this one barrel (kernel gate, store, model) — no second barrel.
export { compilePolicySnapshot, createPolicyCompiler } from "./kernel/gate/compile";
export type { PolicyEvaluationInput } from "./kernel/gate/compile";
export { decisionFromEvaluation, evaluatePermission } from "./kernel/gate/match";
export { KERNEL_POLICY_REGISTRY } from "./kernel/gate/compile";
// Store surface (former ledger package root, minus the channel stores that
// moved to @openomni/channels).
export { openCatalogStore, CATALOG_SCHEMA } from "./store/catalog";
export { bootstrapStoreDatabase, openSessionStore } from "./store/session-file";
export type { ObservationFailurePort, ObservationPublishFailure } from "./store/storage/sqlite-l0-observation";
export { createDecisionFactPort } from "./store/decision";
export * as SessionHandleStore from "./store/fence";
export { createSurfaceKeyStore } from "./store/surface-key";
export { CommitRefused, CorruptRecord } from "./store/errors";
export type { LedgerError } from "./store/errors";
export type { AdoptReceipt, CommitReceipt, LedgerHandles } from "./store/services";
// Catalog persistence helpers the channel stores build on (#1246).
export { requireSubAdapter, withStoreTimestamps } from "./store/storage/timestamped-store";
export { StoredEndpoint, StoredIdentity } from "./store/storage/actor-schema";
// Model surface (former llm package root).
export { LlmRunFailure } from "./model/errors";
export { Llm } from "./model/services";
export { LlmLive } from "./model/layers";
export { Auth } from "./model/auth";
export { Provider, ModelsDev } from "./model/provider";
export { Retry } from "./model/retry";
export { run } from "./model/run";
export type { Run, RunInput } from "./model/run";
export type { Sink } from "./model/sink";
