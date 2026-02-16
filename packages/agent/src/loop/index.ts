// Loop module — conversation/execution supervisors, DAG execution, file locking

export { FileLock } from "./file-lock";

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
