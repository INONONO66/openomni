// Execution domain — DAG execution engine, graph building, agent assignment, review gate

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

export { FileLock } from "./file-lock";
