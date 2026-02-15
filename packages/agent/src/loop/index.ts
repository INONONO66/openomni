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
  OrchestratorRunInput,
} from "./run-worker";

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
} from "./execution-types";

export { ExecutionSupervisor } from "./execution-supervisor";

export {
  buildDependencyGraph,
  completeTaskAndUnblockDependents,
} from "./execution-graph";

export {
  resolveDispatchHybridRuntime,
  assignAgentsToReadyTasks,
  resolveFallbackAgentAssignment,
  resolveWorkerRuntimeForTask,
} from "./execution-assignment";

export {
  decideFailedStepAction,
  reviewTaskResult,
  sendReviewFeedback,
  requestHandoffDocument,
  rotateAgent,
} from "./execution-review";

export {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
  resolveAgentForWorker,
  fallbackToolExecutor,
} from "./agent-resolution";
