// Ingress
export {
  CronAdapter,
  IngressEngine,
  IngressEventProjector,
  IngressAuthorityMiddleware,
  IngressHandlers,
  IngressSessionResolver,
  SessionBridge,
  resolveTarget,
  targetKey,
} from "./ingress";
export type { CoordinatorLike } from "./ingress";

// Resident activation/runtime
export { ResidentRuntime } from "./resident";
export type {
  ResidentLifecycle,
  ResidentRuntimeOptions,
  ResidentRunContext,
  ResidentRunResult,
} from "./resident";

// Resident agent prompts
export { ResidentAgent } from "./agents";
export type {
  ResidentPromptFamily,
  ResidentPromptOptions,
  ResidentPromptSections,
  ResidentPromptVariant,
} from "./agents";

// Kernel wait service (#215): the durable Wait entry (open / attach / sweep)
// plus the sync-ask audit. Correlation and matching stay kernel-internal.
export { WaitService } from "./wait";

// Kernel effect service (#492): the effect driver port, manifest boundary,
// record-before-act service, and finish reconciler over the `effect:<id>`
// class the ledger ships as vocabulary.
export { EffectManifest, EffectRefusal, EffectService, EffectReconciler } from "./effect";
export type {
  EffectDriver,
  EffectEscalation,
  EffectExecution,
  EffectIntent,
  EffectRefusalCode,
  EffectRequest,
  EffectRunResult,
  InputSanitizer,
  ReconcileSummary,
} from "./effect";

export { PolicyResolver } from "./policy";
export type {
  LabelMatcher,
  PolicyResolverInstance,
  PolicyResolverRule,
  ResolverContext,
} from "./policy";

// Execution runtime
export {
  AgentToolProvider,
  ToolProxyProvider,
  SystemToolProvider,
  CronJobRegistry,
  CronJobRunner,
  InjectionQueue,
  Tool,
  WorkspaceLock,
  buildToolCatalog,
  buildWorkerMiddleware,
  createChildAgentRuntime,
  createChildAgentTool,
  createDispatchTool,
  createToolExecutor,
  defineTool,
  ToolRuntimePolicyMiddleware,
  resolveMeta,
  resolveCategory,
  resolveToolSelection,
} from "./execution-runtime";
export type {
  CatalogEntry,
  NativeTool,
  ToolCategory,
  ToolExecutionContext,
  ToolExecutorConfig,
  ToolExecutorContext,
  ToolMetaValue,
  ToolProvider,
  ToolRiskTier,
  ToolSource,
  WorkerMiddlewareConfig,
  ChildAgentRuntime,
  ChildAgentRuntimeOptions,
  ChildAgentSnapshot,
  ChildAgentSpawnInput,
  DelegationPolicyRegistration,
  DispatchToolRuntime,
} from "./execution-runtime";

export {
  ReadBackExecutor,
  VerifierConformance,
  VerifierRegistry,
  runVerifierRegistryDriver,
} from "./evidence";
export type {
  VerifierRegistryDriverExecution,
  VerifierRegistryDriverScenario,
} from "./evidence";

export {
  CompletionAdmissionDriverScenarios,
  CompletionSourceOrigin,
  projectCompletionOrigin,
  runCompletionAdmissionDriver,
} from "./work-item";
export type {
  CompletionAdmissionDriverExecution,
  CompletionAdmissionDriverScenario,
  WorkItemCompletionRecoveryReceipt,
} from "./work-item";

// Dispatch runtime
export {
  DEFAULT_DISPATCH_MODEL,
  DispatchPolicyRegistrationError,
  DispatchRuntime,
  DispatchRegistry,
  createDefaultDispatchRuntime,
  createDefaultDispatchPolicy,
  createDeviceDispatchHandlers,
  createOutboundDispatchHandlers,
  createResidentDispatchHandlers,
  deriveActorContext,
  registerBuiltInDispatchHandlers,
} from "./dispatch";
export type {
  BuiltInDispatchOptions,
  ConnectorEndpointDriverOwner,
  DefaultDispatchRuntimeOptions,
  DefaultDispatchRuntime,
  DeviceDispatchHandlerOptions,
  DeviceDispatchOwner,
  DeviceDispatchOwnerInput,
  DispatchHandler,
  DispatchHandlerContext,
  DispatchHandlerResult,
  DispatchOwners,
  DispatchPolicyContext,
  DispatchPolicyRegistration,
  DispatchPolicyRegistrationErrorCode,
  DispatchRuntimeContext,
  DispatchRuntimeOptions,
  DispatchSchedulerOwner,
  DispatchSubmitOptions,
  OutboundDispatchHandlerOptions,
  OutboundDispatchOwner,
  OutboundDispatchOwnerInput,
} from "./dispatch";
