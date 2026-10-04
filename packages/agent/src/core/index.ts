// Core namespace surface (#1276): the former kernel/ + session/ + store/
// barrels merged — turn/gate/tool/ports/failure contracts, entity, admission,
// requests, run, bus, and the append-only store.
export type { ChatAgentConfig } from "./types";
export { failureFacts } from "./retry";
export * from "./failure";
export * from "./ports";
export * from "./alarm-ports";
export type { CompactionOptions } from "../plugins/compaction";
export {
  createExecutor, ExecutionApprovalError, ExecutorContext, executorContext, ExecutorContextError,
  currentInvocation, forkInvocation,
  type InvocationFrame, type ExecutionApprovalRequest, type Executor,
} from "./gate/decide";
export { compilePolicySnapshot, createPolicyCompiler, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, type PolicyEvaluationInput } from "./gate/compile";
export { decisionFromEvaluation, evaluatePermission } from "./gate/match";
export {
  composePointTable, executionPoint, GateComposeError, KERNEL_CAPABILITY_POINTS,
  type CapabilityPointRegistration, type GatePointTable,
} from "./points";
export { assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } from "./gate/migrate";
export {
  createDispatcher, createTurnDispatcher, currentExecutor, defineTool, eraseTool, sessionTool,
  ToolRefused, toolInputSchema, toolSpec,
} from "./tool";

export {
  adoptSessionAuthority, makeSessionGenerations, createSessionChatRunner, closeSessions, getSessionHandle,
  type GenerationBundle, type SessionHandle, type SessionRunner, type SessionRuntime,
  type SessionCreateOptions, type SessionRunnerInput, type SessionRunnerResult,
  type SessionEntityPorts, type SessionEntityTurnInput,
  type SessionSystem, type ResolvedSessionRuntime,
} from "./run";
export { decideSessionAdmission, requestAuthorityKernel, commitSessionRequest } from "./mailbox";
export { createSessionRequests, decideRequestTransition, requestBindingDigest } from "./request";
export { receivedMessageAction } from "./commit";
export { armAction, firedAction, alarmDisposition, composeAlarmPurposes, AlarmComposeError, AlarmSendRefused, ArmRefused, AlarmWakeError, type AlarmCapability, type AlarmArmNotice, type AlarmChainReads, type AlarmDisposition, type AlarmDrainConfig, type AlarmFired, type AlarmPurposeRegistry, type AlarmSweepConfig, type AlarmWakeContext, type AlarmWakeOutcome, type ArmVerb } from "./alarm";
export { SessionEntity, SessionEntityContext, createSessionEntityLayer, createSessionEntityRunTurn, type SessionKernel } from "./entity";
export { makeObservationBus, observationBusLayer, scopeObservation } from "./bus";
export { forkSession, ForkRefused, isForkBoundary, DEFAULT_FORK_COPY_BYTE_CAP, type ForkInput, type ForkPorts, type ForkReceipt, type ForkRefusalReason } from "./fork";

// ─── journal/store surface (formerly the Journal namespace, #1276) ───
export {
  openCatalogStore, CATALOG_SCHEMA, bootstrapStoreDatabase, openSessionStore,
  readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION,
  createDecisionFactPort, SessionHandleStore, createSurfaceKeyStore,
  CommitRefused, CorruptRecord, requireSubAdapter, withStoreTimestamps,
  StoredEndpoint, StoredIdentity,
} from "./store";
export type {
  ObservationFailurePort, ObservationPublishFailure, LedgerError,
  AdoptReceipt, CommitReceipt, LedgerHandles,
} from "./store";
