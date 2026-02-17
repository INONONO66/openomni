// Worker domain — agent runtime, execution primitive, policy enforcement, telemetry

// Re-exports from ./run sub-domain
export type {
  OrchestratorConfig,
  OrchestrationResult,
  OrchestrationState,
  ToolExecutor,
  SessionMode,
  OrchestratorRunInput,
  SummaryTemplate,
  SummaryData,
} from "./run";
export { RunWorker, SummaryDelivery } from "./run";

// Re-exports from ./policy file
export type {
  ConcurrencyConfig,
  PermissionLevel,
  PermissionDecision,
  PermissionContext,
  RunBudget,
  RunState,
  BudgetStatus,
} from "./policy";
export { ConcurrencyGate, PermissionGate, RunSupervisor } from "./policy";

// Re-exports from ./telemetry file
export type {
  EventMetadata,
  QueueMetrics,
  RunMetrics,
  AuditEntry,
} from "./telemetry";
export { Observability, AuditLog } from "./telemetry";

export { type DLQEntry, DeadLetterQueue } from "./dlq";

export {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
  resolveAgentForWorker,
  fallbackToolExecutor,
} from "./agent-resolution";
