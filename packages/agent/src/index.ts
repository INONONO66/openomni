// Agent package public API: only surfaces consumed by product composition.
export type { ChatAgentConfig } from "./kernel/types";
export { createSessionRequests } from "./session/request";
export { adoptSessionAuthority } from "./session/run";
export { receivedMessageAction } from "./session/commit";
export { decideRequestTransition, requestBindingDigest } from "./session/request";
export { decideSessionAdmission, requestAuthorityKernel } from "./session/mailbox";
export { failureFacts } from "./kernel/retry";
export * as Failure from "./kernel/failure";
export type { CompactionOptions } from "./plugins/compaction";
export { createSessionChatRunner } from "./session/run";
export { attemptUsage, toolWallMs } from "./inspect/metrics";
export { closeSessions, session } from "./session/run";
export { createSessionEntityRunTurn } from "./session-controller";
export { createExecutor, ExecutionApprovalError } from "./kernel/gate/decide";
export * from "./kernel/failure";
export * from "./kernel/ports";
export * from "./kernel/bundle";
export { AgentProcessLive } from "./layers";
export { ExecutorContext, executorContext, ExecutorContextError, currentInvocation, forkInvocation } from "./kernel/gate/decide";
export type { InvocationFrame } from "./kernel/gate/decide";
export { makeSessionGenerations } from "./session/run";
export type { GenerationBundle } from "./session/run";
export type { ExecutionApprovalRequest } from "./kernel/gate/decide";
export { SEEDED_POLICY_ROWS } from "./kernel/gate/compile";
export type { Executor } from "./kernel/gate/decide";
export { createDispatcher, createTurnDispatcher, currentExecutor, defineTool, eraseTool, sessionTool, ToolRefused, toolInputSchema, toolSpec, } from "./kernel/tool";
// W5.2 #1197 cluster surface (plan F6): the Session entity and its composition seams.
export { SessionEntity, SessionEntityContext, SessionEntityLive } from "./session/entity";
export { deadlineDelivery, retryDelivery, watchFiredDelivery, watchTimeoutDelivery, type TimerChainReads, } from "./session/alarm";
export type { SessionEntityPorts, SessionEntityTimerContext, SessionEntityTurnInput, } from "./session/run";
export { createObservationBus, scopeObservation } from "./session/bus";
export type { SessionHandle, SessionRunner, SessionRuntime } from "./session/run";
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
