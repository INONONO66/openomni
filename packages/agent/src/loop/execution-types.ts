import type { AgentDefinition } from "../agent";
import type { OrchestratorRunInput, SessionMode } from "../worker/run-worker";

export type SupervisorDecision = "local" | "spawn" | "join" | "finish";

/**
 * Summarized history package forwarded from ConversationSupervisor.
 * Raw full transcript is never passed (D10).
 */
export interface SummarizedHistory {
  summary: string;
  constraints: string[];
}

/**
 * Approved plan package that drives task decomposition and dispatch.
 * Created by ConversationSupervisor after user approval (D11).
 */
export interface ExecutionPlan {
  planId: string;
  objective: string;
  steps: ExecutionPlanStep[];
}

export interface ExecutionPlanStep {
  stepId: string;
  description: string;
  dependsOn: string[];
  suggestedAgent?: string;
}

/**
 * Configuration input for ExecutionSupervisor.
 * Receives summarized history + approved plan from ConversationSupervisor.
 */
export interface ExecutionSupervisorConfig {
  history: SummarizedHistory;
  plan: ExecutionPlan;
  /** Always `persistent` for ExecutionSupervisor (canonical policy) */
  sessionMode: SessionMode;
  sessionId: string;
  traceId: string;
  agentId?: string;
  availableAgents?: string[];
}

export interface ExecutionSupervisorResult {
  success: boolean;
  summary: string;
  error?: string;
  terminalDecision: SupervisorDecision;
  stepOutcomes: StepOutcome[];
}

export interface StepOutcome {
  stepId: string;
  success: boolean;
  summary: string;
  error?: string;
}

export type DispatchTaskStatus = "pending" | "running" | "completed" | "failed";

export interface DispatchReviewInput {
  objective: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  summary: string;
  error?: string;
  attempt: number;
  rejectionStreak: number;
  feedbackHistory: string[];
}

export interface DispatchReviewDecision {
  decision: "accept" | "reject";
  feedback?: string;
}

export interface DispatchContext {
  parentDepth?: number;
  maxDepth?: number;
  abortSignal?: AbortSignal;
  llm: OrchestratorRunInput["llm"];
  toolExecutor?: OrchestratorRunInput["toolExecutor"];
  agentId?: string;
  availableAgents?: string[];
  timeoutMs?: number;
  review?: (
    input: DispatchReviewInput,
  ) => DispatchReviewDecision | Promise<DispatchReviewDecision>;
  parentTaskId?: string;
  parentRunId?: string;
  parentSessionId?: string;
  insideDelegation?: boolean;
}

export interface DispatchTask {
  id: string;
  description: string;
  agentType: string;
  suggestedAgent?: string;
  dependencies: string[];
  fileScope: string[];
}

export interface DispatchExecutionInput {
  objective: string;
  tasks: DispatchTask[];
}

export interface DispatchOutput {
  success: boolean;
  objective: string;
  durationMs: number;
  completedTaskIds: string[];
  results: Array<{
    id: string;
    childTaskId: string;
    status: DispatchTaskStatus;
    attempts: number;
    rejections: number;
    handoffs: number;
    sessionId: string;
    agentHistory: string[];
    summary?: string;
    error?: string;
  }>;
  error?: string;
}

export interface DispatchTaskState {
  task: DispatchTask;
  childTaskId: string;
  status: DispatchTaskStatus;
  sessionId: string;
  agentInstanceId: string;
  agentHistory: string[];
  attempts: number;
  rejectionStreak: number;
  totalRejections: number;
  handoffs: number;
  summaries: string[];
  feedbackHistory: string[];
  errors: string[];
  handoffDocument?: string;
}

export interface DependencyGraph {
  states: Map<string, DispatchTaskState>;
  pendingDependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

export interface ChildRunResult {
  runId: string;
  success: boolean;
  summary: string;
  error: string;
}

export interface RunningTask {
  taskId: string;
  runId: string;
  lockOwner: string;
  lockedFiles: string[];
  promise: Promise<ChildRunResult>;
}

export interface ExecutionSupervisorRuntime {
  dispatchContext?: DispatchContext;
  dispatchTasksByStepId?: Map<string, DispatchTask>;
}

export interface ExecutionSupervisorConfigInternal extends ExecutionSupervisorConfig {
  __dispatchRuntime?: ExecutionSupervisorRuntime;
}

export type FailureAction = "retry" | "skip" | "replan";

export interface ReadyStepDescriptor {
  stepId: string;
  description: string;
  suggestedAgent?: string;
}

export interface AgentAssignment {
  stepId: string;
  agentId: string;
}

export interface FailureDecision {
  action: FailureAction;
  reasoning: string;
}

export interface DispatchHybridRuntime {
  supervisorAgentId: string;
  supervisorAgent: AgentDefinition;
  supervisorLLM: OrchestratorRunInput["llm"];
  supervisorSystemPrompt: string;
  availableAgents: string[];
}

export interface WorkerRuntimeConfig {
  agent: AgentDefinition;
  llm: OrchestratorRunInput["llm"];
  toolExecutor?: OrchestratorRunInput["toolExecutor"];
  systemPrompt: string;
}
