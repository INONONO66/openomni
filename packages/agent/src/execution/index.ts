// Execution domain — DAG execution engine, graph building, agent assignment, review gate

export {
  type SupervisorDecision,
  type SummarizedHistory,
  type ExecutionPlan,
  type ExecutionPlanStep,
  type ExecutionSupervisorConfig,
  type ExecutionSupervisorResult,
  type StepOutcome,
  type DispatchExecutionInput,
  type DispatchOutput,
  type DispatchTask,
  type DispatchContext,
  type DispatchReviewDecision,
  type DispatchReviewInput,
} from "./execution-types";

export { ExecutionSupervisor } from "./execution-supervisor";

export {
  FileLock,
  buildDependencyGraph,
  completeTaskAndUnblockDependents,
  resolveDispatchHybridRuntime,
  assignAgentsToReadyTasks,
  resolveFallbackAgentAssignment,
  resolveWorkerRuntimeForTask,
  type RunSupervisorToolDecision,
} from "./graph";

export {
  decideFailedStepAction,
  reviewTaskResult,
  sendReviewFeedback,
  requestHandoffDocument,
  rotateAgent,
  type ExecuteChildRunWithAbort,
} from "./execution-review";
