// Public API for @openomni/openomni — see AGENTS.md for the module map.
// Plan Mode
export {
  Hashline,
  InMemoryPlanStore,
  PLAN_TOOL_SPECS,
  PlanAgent,
  PlanPipeline,
  SpecValidator,
  StructuralGate,
  createPlanToolExecutor,
  normalizePlanPayload,
  structuralGateCheck,
} from "./plan";
export type { EditResult, PlanDocument, PlanStore } from "./plan";

// Team Mode
export {
  ApprovalGate,
  EvaluationGate,
  ReviewLoop,
  RunLedger,
  StallDetector,
  TEAM_AGENTS,
  TeamOrchestrator,
  Teammate,
  getAgentMetadata,
  resolveTeamAgent,
} from "./team";
export type { TeamAgentDefinition } from "./team";

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

// Task Storage
export { FileTaskStore, TaskStorage } from "./storage";

// Category System
export { BUILTIN_CATEGORIES, resolveCategory } from "./category";
export type { CategoryConfig, CategoryResolution } from "./category";

// Subagent runtime
export { SubagentRuntime } from "./subagent";
