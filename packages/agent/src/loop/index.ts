// Loop module - Phase 2 implementation
// Event routing, dispatching, and concurrency control

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

export { FileLock } from "./file-lock";

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

export type {
  SupervisorDecision,
  SummarizedHistory,
  ExecutionPlan,
  ExecutionPlanStep,
  ExecutionSupervisorConfig,
  ExecutionSupervisorResult,
  StepOutcome,
  DispatchContext,
  DispatchExecutionInput,
  DispatchOutput,
  DispatchReviewDecision,
  DispatchReviewInput,
  DispatchTask,
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
