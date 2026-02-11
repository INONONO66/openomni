// Loop module - Phase 2 implementation
// Event routing, dispatching, and concurrency control

export {
  EventEnvelope,
  NormalizedEvent,
  ValidationError,
  normalize,
  Envelope,
} from "./envelope";

export { Router, RouterRule, RoutingDecision } from "./router";

export { Dispatcher } from "./dispatcher";

export { ConcurrencyConfig, ConcurrencyGate } from "./concurrency";

export {
  PermissionLevel,
  PermissionDecision,
  PermissionContext,
  PermissionGate,
} from "./permission";

export {
  RunBudget,
  RunState,
  BudgetStatus,
  RunSupervisor,
} from "./run-supervisor";

export {
  OrchestratorConfig,
  OrchestrationResult,
  OrchestrationState,
  ToolExecutor,
  SessionMode,
} from "./orchestration";

export { RunWorker } from "./run-worker";

export { FileLock } from "./file-lock";

export { DLQEntry, DeadLetterQueue } from "./dlq";

export { SummaryTemplate, SummaryData, SummaryDelivery } from "./summary";

export {
  EventMetadata,
  QueueMetrics,
  RunMetrics,
  Observability,
} from "./observability";

export { AuditEntry, AuditLog } from "./audit";

export {
  ConversationSupervisor,
  type ConversationSupervisorConfig,
  type ConversationInput,
  type ConversationPlan,
  type WorkItemOutline,
  type ApprovalDecision,
  type ExecutionContextFork,
  type ConversationHistory,
  type ConversationSupervisorResult,
} from "./conversation-supervisor";

export {
  SupervisorDecision,
  SummarizedHistory,
  ExecutionPlan,
  ExecutionPlanStep,
  ExecutionSupervisorConfig,
  ExecutionSupervisorResult,
  StepOutcome,
  ExecutionSupervisor,
} from "./execution-supervisor";
