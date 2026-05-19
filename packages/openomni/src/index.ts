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
export { ResidentRuntime, createResidentWorkerTools } from "./resident";
export type {
  ResidentLifecycle,
  ResidentRuntimeOptions,
  ResidentRunContext,
  ResidentRunResult,
  ResidentWorkerToolsOptions,
} from "./resident";

// Skill loader and activation
export { SkillLoader, SkillManager, SkillRegistry, createSkillActivationMiddleware } from "./skill";
export type {
  SkillAuditContext,
  SkillActivationMiddlewareOptions,
  SkillInstallOptions,
  SkillListOptions,
  SkillLoaderOptions,
  SkillManagerEntry,
  SkillManagerRoots,
  SkillOperationOptions,
  SkillRegistryOptions,
  SkillUninstallOptions,
} from "./skill";

// Extension lifecycle management
export { ExtensionManager, RuntimeBinding } from "./extension";
export type {
  ExtensionAuditContext,
  ExtensionAuditEntry,
  ExtensionAuditOptions,
  ExtensionBindingOperationOptions,
  ExtensionLifecycleAuditEntry,
  ExtensionListOptions,
  ExtensionManagerEntry,
  ExtensionManifestSummary,
  ExtensionOperationAuditEntry,
  ExtensionOperationOptions,
  ExtensionRequestInstallOptions,
  ExtensionRollbackOptions,
  ExtensionValidationFailure,
  ExtensionValidationResult,
  ExtensionValidationSuccess,
  ExtensionVersionOperationOptions,
  RuntimeAgentTarget,
  RuntimeBindingContext,
  RuntimeBindingController,
  RuntimeBindingExtension,
  RuntimeBindingTargets,
  RuntimeMcpTarget,
  RuntimeMiddlewareTarget,
  RuntimeSkillTarget,
  RuntimeSurfaceTarget,
  RuntimeToolTarget,
} from "./extension";

// Subagent runtime
export {
  SubagentRuntime,
  SubagentSpawnPolicyMiddleware,
  BackgroundLimitsMiddleware,
  SubagentConsultation,
  BackgroundManager,
} from "./subagent";

// Policy compatibility exports
/**
 * @deprecated Use `BackgroundLimitsMiddleware` from the package root for new code.
 */
export { BackgroundLimitsPolicy } from "./policy";
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
  Tool,
  WorkspaceLock,
  buildToolCatalog,
  buildWorkerMiddleware,
  buildWorkerChildRuntimeConfig,
  createToolExecutor,
  createWorkerSubagentRuntime,
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
} from "./execution-runtime";
