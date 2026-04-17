// Public API for @openomni/openomni — see AGENTS.md for the module map.
// Plan Mode
export {
  Hashline,
  InMemoryPlanStore,
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

// Task Storage
export { SqliteTaskStore, TaskStorage } from "./storage";

// Subagent runtime
export { SubagentRuntime, SubagentConsultation, BackgroundManager } from "./subagent";

// Execution runtime
export {
  AgentToolProvider,
  McpProxyToolProvider,
  SystemToolProvider,
  Tool,
  buildWorkerMiddleware,
  createToolExecutor,
  createWorkerSubagentRuntime,
  defineTool,
  resolveMeta,
} from "./execution-runtime";
export type {
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
