// Kernel namespace surface (#1247): turn/gate/tool/ports/failure contracts.
export type { ChatAgentConfig } from "./types";
export { failureFacts } from "./retry";
export * from "./failure";
export * from "./ports";
export * from "./alarm";
export type { CompactionOptions } from "../plugins/compaction";
export {
  createExecutor,
  ExecutionApprovalError,
  ExecutorContext,
  executorContext,
  ExecutorContextError,
  currentInvocation,
  forkInvocation,
  type InvocationFrame,
  type ExecutionApprovalRequest,
  type Executor,
} from "./gate/decide";
export {
  compilePolicySnapshot,
  createPolicyCompiler,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
  type PolicyEvaluationInput,
} from "./gate/compile";
export { decisionFromEvaluation, evaluatePermission } from "./gate/match";
export {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  eraseTool,
  sessionTool,
  ToolRefused,
  toolInputSchema,
  toolSpec,
} from "./tool";
