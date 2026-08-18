// Ingress
export {
  CronAdapter,
  createIngressEngine,
  IngressAuthorityMiddleware,
  SessionBridge,
} from "./ingress";
export type {
  AgentResolver,
  CoordinatorLike,
  IngressEngine,
  IngressEngineDeps,
} from "./ingress";

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

export type {
  LabelMatcher,
  PolicyResolverInstance,
  PolicyResolverRule,
  ResolverContext,
} from "./policy";

// Execution runtime
export {
  AgentToolProvider,
  SystemToolProvider,
  CronJobRunner,
  InjectionQueue,
  Tool,
  WorkspaceLock,
  buildToolCatalog,
  buildWorkerMiddleware,
  createAnchorCompletion,
  createChildAgentRuntime,
  createChildAgentTool,
  createDispatchTool,
  createToolExecutor,
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

// Evidence conformance vocabulary (#493-owned dormant replay types ride this
// namespace; the entry re-export keeps them public until archived replay lands)
export * as VerifierConformance from "./evidence/verifier-conformance";

// Dispatch runtime (openomni product runtime for protocol Command submits)
export {
  DEFAULT_DISPATCH_MODEL,
  DispatchRuntime,
  createDefaultDispatchRuntime,
  createDefaultDispatchPolicy,
  createDeviceDispatchHandlers,
  createOutboundDispatchHandlers,
  createResidentDispatchHandlers,
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
