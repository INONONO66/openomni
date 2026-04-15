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

// Subagent runtime
export { SubagentRuntime, SubagentConsultation, BackgroundManager } from "./subagent";
