// Public API for @openomni/openomni — see AGENTS.md for the module map.
// Plan Mode
export {
  Hashline,
  PLAN_TOOL_SPECS,
  PlanAgent,
  PlanPipeline,
  StructuralGate,
  createPlanToolExecutor,
  structuralGateCheck,
} from "./plan";
export type { EditResult, PlanDocument, PlanStore } from "./plan";

// DAG utilities
export { DAG } from "./dag";
export type { DAGStructure } from "./dag";

// Ingress
export {
  IngressEngine,
  IngressEventProjector,
  IngressHandlers,
  IngressSessionResolver,
  SessionBridge,
} from "./ingress";
export type { CoordinatorLike } from "./ingress";

// Subagent runtime
export { SubagentRuntime, SubagentConsultation, BackgroundManager } from "./subagent";

// Execution runtime
export {
  AgentToolProvider,
  ToolProxyProvider,
  SystemToolProvider,
  Tool,
  WorkspaceLock,
  buildToolCatalog,
  buildWorkerMiddleware,
  createToolExecutor,
  createWorkerSubagentRuntime,
  defineTool,
  resolveMeta,
  resolveCategory,
  resolveToolSelection,
} from "./execution-runtime";
export type {
  CatalogEntry,
  NativeTool,
  ToolCategory,
  ToolExecutorConfig,
  ToolExecutorContext,
  ToolMetaValue,
  ToolProvider,
  ToolRiskTier,
  ToolSource,
  WorkerMiddlewareConfig,
} from "./execution-runtime";
