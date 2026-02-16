// Worker domain — agent runtime, execution primitive, policy enforcement, telemetry

export { type ConcurrencyConfig, ConcurrencyGate } from "./concurrency";

export {
  type PermissionLevel,
  type PermissionDecision,
  type PermissionContext,
  PermissionGate,
} from "./permission";

export {
  type RunBudget,
  type RunState,
  type BudgetStatus,
  RunSupervisor,
} from "./run-supervisor";

export type {
  OrchestratorConfig,
  OrchestrationResult,
  OrchestrationState,
  ToolExecutor,
  SessionMode,
  OrchestratorRunInput,
} from "./run-worker";

export { RunWorker } from "./run-worker";

export { type DLQEntry, DeadLetterQueue } from "./dlq";

export {
  type SummaryTemplate,
  type SummaryData,
  SummaryDelivery,
} from "./summary";

export {
  type EventMetadata,
  type QueueMetrics,
  type RunMetrics,
  Observability,
} from "./observability";

export { type AuditEntry, AuditLog } from "./audit";

export {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
  resolveAgentForWorker,
  fallbackToolExecutor,
} from "./agent-resolution";

// Re-export from run-worker-sink (no public types, internal utility)
export {} from "./run-worker-sink";
