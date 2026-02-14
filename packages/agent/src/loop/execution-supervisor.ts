import type { Tool } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { AgentMessenger } from "../agent/communication";
import { BuiltinAgentRegistry, type AgentDefinition } from "../agent/registry";
import { TaskManager } from "../task/manager";
import {
  resolveAgentDefinition,
  resolveAgentForWorker,
} from "./agent-resolution";
import { FileLock } from "./file-lock";
import type {
  OrchestratorConfig,
  OrchestratorRunInput,
  SessionMode,
  ToolExecutor,
} from "./run-worker";
import { RunWorker } from "./run-worker";

const DEFAULT_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const MAX_REJECTIONS_BEFORE_HANDOFF = 3;
const DISPATCH_AGENT_ID = "dispatch-supervisor";
const ASSIGN_AGENTS_TOOL = "assign_agents";
const HANDLE_FAILURE_TOOL = "handle_failure";
const SUPERVISOR_DECISION_TRIGGER_ID = "dispatch-supervisor-trigger";

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

interface DispatchTaskState {
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

interface DependencyGraph {
  states: Map<string, DispatchTaskState>;
  pendingDependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

interface ChildRunResult {
  runId: string;
  success: boolean;
  summary: string;
  error: string;
}

interface RunningTask {
  taskId: string;
  runId: string;
  lockOwner: string;
  lockedFiles: string[];
  promise: Promise<ChildRunResult>;
}

interface ExecutionSupervisorRuntime {
  dispatchContext?: DispatchContext;
  dispatchTasksByStepId?: Map<string, DispatchTask>;
}

interface ExecutionSupervisorConfigInternal extends ExecutionSupervisorConfig {
  __dispatchRuntime?: ExecutionSupervisorRuntime;
}

type FailureAction = "retry" | "skip" | "replan";

interface ReadyStepDescriptor {
  stepId: string;
  description: string;
  suggestedAgent?: string;
}

interface AgentAssignment {
  stepId: string;
  agentId: string;
}

interface FailureDecision {
  action: FailureAction;
  reasoning: string;
}

interface DispatchHybridRuntime {
  supervisorAgentId: string;
  supervisorAgent: AgentDefinition;
  supervisorLLM: OrchestratorRunInput["llm"];
  supervisorSystemPrompt: string;
  availableAgents: string[];
}

interface WorkerRuntimeConfig {
  agent: AgentDefinition;
  llm: OrchestratorRunInput["llm"];
  toolExecutor?: OrchestratorRunInput["toolExecutor"];
  systemPrompt: string;
}

/**
 * Orchestration decision layer for a run (D8).
 *
 * - Internal-only: created by ConversationSupervisor after plan approval (D9)
 * - Receives summarized history + approved plan, not raw transcript (D10)
 * - Session mode: `persistent`
 * - Delegates execution to RunWorker — never executes LLM/tool loops directly
 */
export namespace ExecutionSupervisor {
  /**
   * Decision loop: plan -> select -> delegate -> re-evaluate.
   */
  export async function run(
    config: ExecutionSupervisorConfig,
  ): Promise<ExecutionSupervisorResult> {
    const stepOutcomes: StepOutcome[] = [];

    while (true) {
      const decision = await plan(config, stepOutcomes);

      if (decision === "finish") {
        break;
      }

      const selectedSteps = select(config.plan, stepOutcomes, decision);

      // ┌─────────────────────────────────────────────────────────┐
      // │ WORKER INVOCATION BOUNDARY                              │
      // │ Everything below this point is RunWorker's              │
      // │ responsibility. ExecutionSupervisor MUST NOT execute    │
      // │ LLM calls or tool loops directly.                       │
      // └─────────────────────────────────────────────────────────┘
      const outcomes = await delegate(decision, selectedSteps, config);
      stepOutcomes.push(...outcomes);
    }

    const allSucceeded = stepOutcomes.every((o) => o.success);

    return {
      success: allSucceeded,
      summary:
        stepOutcomes.map((o) => o.summary).join("\n") || "No work executed.",
      error: allSucceeded
        ? undefined
        : stepOutcomes
            .filter((o) => !o.success)
            .map((o) => o.error)
            .join("; "),
      terminalDecision: "finish",
      stepOutcomes,
    };
  }

  export async function executeDispatch(
    input: DispatchExecutionInput,
    context: DispatchContext,
  ): Promise<DispatchOutput> {
    return executeDispatchGraph(input, context);
  }

  async function plan(
    config: ExecutionSupervisorConfig,
    completedOutcomes: StepOutcome[],
  ): Promise<SupervisorDecision> {
    const completedIds = new Set(completedOutcomes.map((o) => o.stepId));

    if (completedIds.size >= config.plan.steps.length) {
      return "finish";
    }

    return "local";
  }

  function select(
    executionPlan: ExecutionPlan,
    completedOutcomes: StepOutcome[],
    _decision: SupervisorDecision,
  ): ExecutionPlanStep[] {
    const completedIds = new Set(completedOutcomes.map((o) => o.stepId));

    return executionPlan.steps.filter(
      (step) =>
        !completedIds.has(step.stepId) &&
        step.dependsOn.every((dep) => completedIds.has(dep)),
    );
  }

  /**
   * Worker invocation boundary — delegates to the appropriate worker.
   *
   * - `local`: Delegate to RunWorker
   * - `spawn`: Delegate to SubagentWorker(s) via RunWorker
   * - `join`: Collect results from spawned workers
   */
  async function delegate(
    decision: SupervisorDecision,
    steps: ExecutionPlanStep[],
    config: ExecutionSupervisorConfig,
  ): Promise<StepOutcome[]> {
    if (decision === "finish" || steps.length === 0) {
      return [];
    }

    const runtime = getDispatchRuntime(config);
    if (!runtime?.dispatchContext) {
      return steps.map((step) => ({
        stepId: step.stepId,
        success: false,
        summary: "",
        error: "ExecutionSupervisor delegate requires dispatch runtime context",
      }));
    }

    const input = buildDispatchInputFromSteps(
      config.plan.objective,
      steps,
      runtime.dispatchTasksByStepId,
    );

    const dispatchContext: DispatchContext = {
      ...runtime.dispatchContext,
      ...(config.agentId ? { agentId: config.agentId } : {}),
      ...(config.availableAgents
        ? { availableAgents: [...config.availableAgents] }
        : {}),
    };

    const output = await executeDispatchGraph(input, dispatchContext);
    const resultById = new Map(
      output.results.map((result) => [result.id, result]),
    );

    return steps.map((step) => {
      const result = resultById.get(step.stepId);
      if (!result) {
        return {
          stepId: step.stepId,
          success: false,
          summary: "",
          error: `Missing dispatch result for step ${step.stepId}`,
        };
      }

      return {
        stepId: step.stepId,
        success: result.status === "completed",
        summary: result.summary ?? "",
        error: result.error,
      };
    });
  }
}

async function executeDispatchGraph(
  input: DispatchExecutionInput,
  context: DispatchContext,
): Promise<DispatchOutput> {
  const startedAt = Date.now();
  const graph = buildDependencyGraph(input.tasks);
  const hybridRuntime = await resolveDispatchHybridRuntime(context);
  const workerRuntimeCache = new Map<
    string,
    Promise<WorkerRuntimeConfig | undefined>
  >();

  initializeTaskStates(graph, input.objective);

  const ready = new Set<string>();
  for (const [taskId, dependencies] of graph.pendingDependencies.entries()) {
    if (dependencies.size === 0) {
      ready.add(taskId);
    }
  }

  const completed = new Set<string>();
  const running = new Map<string, RunningTask>();
  const timeoutMs = context.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

  const dispatchAbortController = new AbortController();
  let abortReason: "timeout" | "parent_abort" | undefined;

  const timeoutId = setTimeout(() => {
    abortReason = "timeout";
    dispatchAbortController.abort();
  }, timeoutMs);

  const parentSignal = context.abortSignal;
  const onParentAbort = () => {
    abortReason = "parent_abort";
    dispatchAbortController.abort();
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortReason = "parent_abort";
      dispatchAbortController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  try {
    await assignAgentsToReadyTasks(
      input.objective,
      graph,
      ready,
      hybridRuntime,
      context,
      dispatchAbortController.signal,
    );

    await dispatchReadyTasks(
      input.objective,
      graph,
      ready,
      running,
      context,
      dispatchAbortController.signal,
      hybridRuntime,
      workerRuntimeCache,
    );

    while (completed.size < graph.states.size) {
      if (dispatchAbortController.signal.aborted) {
        cancelRunningChildren(
          running,
          abortReason === "timeout"
            ? "dispatch_timeout"
            : "dispatch_parent_aborted",
        );
        markPendingAsFailed(
          graph,
          abortReason === "timeout"
            ? "Dispatch timed out"
            : "Dispatch aborted by parent",
        );
        return buildOutput(
          input.objective,
          graph,
          startedAt,
          false,
          abortReason === "timeout"
            ? "Dispatch timed out"
            : "Dispatch aborted by parent",
        );
      }

      await assignAgentsToReadyTasks(
        input.objective,
        graph,
        ready,
        hybridRuntime,
        context,
        dispatchAbortController.signal,
      );

      await dispatchReadyTasks(
        input.objective,
        graph,
        ready,
        running,
        context,
        dispatchAbortController.signal,
        hybridRuntime,
        workerRuntimeCache,
      );

      if (running.size === 0) {
        markPendingAsFailed(
          graph,
          "Dispatch deadlock: unresolved dependencies or file lock contention",
        );
        return buildOutput(
          input.objective,
          graph,
          startedAt,
          false,
          "Dispatch deadlock: unresolved dependencies or file lock contention",
        );
      }

      const next = await waitForNextResult(
        running,
        dispatchAbortController.signal,
      );

      if (next.type === "aborted") {
        cancelRunningChildren(
          running,
          abortReason === "timeout"
            ? "dispatch_timeout"
            : "dispatch_parent_aborted",
        );
        markPendingAsFailed(
          graph,
          abortReason === "timeout"
            ? "Dispatch timed out"
            : "Dispatch aborted by parent",
        );
        return buildOutput(
          input.objective,
          graph,
          startedAt,
          false,
          abortReason === "timeout"
            ? "Dispatch timed out"
            : "Dispatch aborted by parent",
        );
      }

      running.delete(next.taskId);
      releaseFileLocks(next.running.lockedFiles, next.running.lockOwner);

      const state = graph.states.get(next.taskId);
      if (!state) {
        continue;
      }

      state.status = "pending";

      if (next.result.summary.length > 0) {
        state.summaries.push(next.result.summary);
      }
      if (next.result.error.length > 0) {
        state.errors.push(next.result.error);
      }

      let failureDecision: FailureDecision | undefined;
      if (!next.result.success) {
        failureDecision = await decideFailedStepAction(
          input.objective,
          state,
          next.result,
          hybridRuntime,
          context,
          dispatchAbortController.signal,
        );

        if (failureDecision?.action === "skip") {
          if (failureDecision.reasoning.trim().length > 0) {
            state.summaries.push(`Skipped: ${failureDecision.reasoning}`);
          }
          completeTaskAndUnblockDependents(
            graph,
            state.task.id,
            completed,
            ready,
          );
          continue;
        }

        if (failureDecision?.action === "replan") {
          const reason =
            failureDecision.reasoning.trim() ||
            "Supervisor requested replan for failed step";
          state.status = "failed";
          state.errors.push(`Replan requested: ${reason}`);
          markPendingAsFailed(graph, "Dispatch requires replan");
          return buildOutput(
            input.objective,
            graph,
            startedAt,
            false,
            `Dispatch requires replan: ${reason}`,
          );
        }
      }

      const reviewDecision: DispatchReviewDecision =
        !next.result.success && failureDecision
          ? {
              decision: "reject",
              feedback:
                failureDecision.reasoning ||
                next.result.error ||
                "Task execution failed",
            }
          : await reviewTaskResult(
              input.objective,
              state,
              next.result,
              context,
            );

      if (reviewDecision.decision === "accept") {
        completeTaskAndUnblockDependents(
          graph,
          state.task.id,
          completed,
          ready,
        );

        continue;
      }

      const feedback =
        reviewDecision.feedback ||
        next.result.error ||
        "Result rejected. Revise and retry.";

      state.totalRejections += 1;
      state.rejectionStreak += 1;
      state.feedbackHistory.push(feedback);

      await sendReviewFeedback(state, next.result.runId, feedback);

      if (state.rejectionStreak >= MAX_REJECTIONS_BEFORE_HANDOFF) {
        state.handoffDocument = await requestHandoffDocument(
          input.objective,
          state,
          context,
          dispatchAbortController.signal,
        );
        rotateAgent(state, input.objective);
      }

      ready.add(state.task.id);
    }

    return buildOutput(input.objective, graph, startedAt, true);
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
    cancelRunningChildren(running, "dispatch_cleanup");
  }
}

async function resolveDispatchHybridRuntime(
  context: DispatchContext,
): Promise<DispatchHybridRuntime | undefined> {
  if (!context.agentId) {
    return undefined;
  }

  const supervisorAgent = resolveAgentDefinition(context.agentId);
  if (!supervisorAgent) {
    return undefined;
  }

  const availableAgents = resolveAvailableAgentIds(context.availableAgents);
  if (availableAgents.length === 0) {
    return undefined;
  }

  let supervisorLLM = context.llm;
  let supervisorSystemPrompt = supervisorAgent.systemPrompt;

  if (supervisorAgent.model) {
    try {
      const resolved = await resolveAgentForWorker(context.agentId);
      supervisorLLM = resolved.llm;
      if (typeof resolved.input.system === "string") {
        const systemPrompt = resolved.input.system.trim();
        if (systemPrompt.length > 0) {
          supervisorSystemPrompt = systemPrompt;
        }
      }
    } catch (error) {
      console.warn(
        "[ExecutionSupervisor] Supervisor agent resolution failed for",
        context.agentId,
        "- falling back to context.llm. Error:",
        error,
      );
    }
  }

  return {
    supervisorAgentId: context.agentId,
    supervisorAgent,
    supervisorLLM,
    supervisorSystemPrompt,
    availableAgents,
  };
}

function resolveAvailableAgentIds(availableAgents?: string[]): string[] {
  const registeredAgentIds = new Set(
    BuiltinAgentRegistry.list().map((agent) => agent.name),
  );

  if (availableAgents && availableAgents.length > 0) {
    return Array.from(
      new Set(
        availableAgents.filter((agentId) => registeredAgentIds.has(agentId)),
      ),
    );
  }

  return Array.from(registeredAgentIds);
}

async function assignAgentsToReadyTasks(
  objective: string,
  graph: DependencyGraph,
  ready: Set<string>,
  hybridRuntime: DispatchHybridRuntime | undefined,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!hybridRuntime || abortSignal.aborted) {
    return;
  }

  const readyStates = Array.from(ready)
    .map((taskId) => graph.states.get(taskId))
    .filter((state): state is DispatchTaskState => {
      if (!state) {
        return false;
      }
      return state.status !== "completed" && state.status !== "failed";
    });

  if (readyStates.length === 0) {
    return;
  }

  const readySteps: ReadyStepDescriptor[] = readyStates.map((state) => ({
    stepId: state.task.id,
    description: state.task.description,
    suggestedAgent: state.task.suggestedAgent,
  }));

  const assignments = await requestAgentAssignments(
    objective,
    readySteps,
    hybridRuntime,
    context,
    abortSignal,
  );

  const assignmentByStep = new Map(
    assignments.map((assignment) => [assignment.stepId, assignment.agentId]),
  );

  for (const state of readyStates) {
    const fallbackAgent = resolveFallbackAgentAssignment(
      state.task,
      hybridRuntime.availableAgents,
    );
    const assignedAgent = assignmentByStep.get(state.task.id) ?? fallbackAgent;
    if (!assignedAgent) {
      continue;
    }

    if (!BuiltinAgentRegistry.has(assignedAgent)) {
      continue;
    }

    state.task.agentType = assignedAgent;
  }
}

function resolveFallbackAgentAssignment(
  task: DispatchTask,
  availableAgents: string[],
): string | undefined {
  if (
    task.suggestedAgent &&
    availableAgents.includes(task.suggestedAgent) &&
    BuiltinAgentRegistry.has(task.suggestedAgent)
  ) {
    return task.suggestedAgent;
  }

  if (
    availableAgents.includes(task.agentType) &&
    BuiltinAgentRegistry.has(task.agentType)
  ) {
    return task.agentType;
  }

  return availableAgents.find((agentId) => BuiltinAgentRegistry.has(agentId));
}

async function decideFailedStepAction(
  objective: string,
  state: DispatchTaskState,
  result: ChildRunResult,
  hybridRuntime: DispatchHybridRuntime | undefined,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<FailureDecision | undefined> {
  if (!hybridRuntime || abortSignal.aborted) {
    return undefined;
  }

  return requestFailureDecision(
    objective,
    {
      stepId: state.task.id,
      error: result.error,
      attempts: state.attempts,
    },
    hybridRuntime,
    context,
    abortSignal,
  );
}

async function requestAgentAssignments(
  objective: string,
  readySteps: ReadyStepDescriptor[],
  hybridRuntime: DispatchHybridRuntime,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<AgentAssignment[]> {
  const fallbackAssignments = readySteps
    .map((step) => {
      const fallbackAgent = resolveFallbackAgentAssignment(
        {
          id: step.stepId,
          description: step.description,
          agentType: "implement",
          suggestedAgent: step.suggestedAgent,
          dependencies: [],
          fileScope: [],
        },
        hybridRuntime.availableAgents,
      );

      if (!fallbackAgent) {
        return undefined;
      }

      return {
        stepId: step.stepId,
        agentId: fallbackAgent,
      };
    })
    .filter((assignment): assignment is AgentAssignment => Boolean(assignment));

  let selectedAssignments = fallbackAssignments;
  const stepIds = new Set(readySteps.map((step) => step.stepId));
  const availableAgentIds = new Set(hybridRuntime.availableAgents);

  const decisionToolExecutor: ToolExecutor = {
    async execute(calls: Tool.Call[]): Promise<Tool.Result[]> {
      return calls.map((call) => {
        if (call.tool !== ASSIGN_AGENTS_TOOL) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Unsupported supervisor tool: ${call.tool}`,
            isError: true,
          };
        }

        const parsed = parseAgentAssignments(
          call.input,
          stepIds,
          availableAgentIds,
        );
        if (parsed.length > 0) {
          selectedAssignments = parsed;
        }

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify({ assignments: selectedAssignments }),
          isError: false,
        };
      });
    },
  };

  const prompt = [
    "Assign agents for the ready dispatch steps.",
    "Call assign_agents with the selected { stepId, agentId } pairs.",
    `Objective: ${objective}`,
    `Ready Steps: ${JSON.stringify(readySteps)}`,
    `Available Agents: ${JSON.stringify(hybridRuntime.availableAgents)}`,
    "Prefer suggestedAgent when it matches capabilities.",
  ].join("\n\n");

  await runSupervisorToolDecision(
    prompt,
    [ASSIGN_AGENTS_TOOL],
    decisionToolExecutor,
    hybridRuntime,
    context,
    abortSignal,
  );

  const assignmentByStep = new Map(
    fallbackAssignments.map((assignment) => [
      assignment.stepId,
      assignment.agentId,
    ]),
  );
  for (const assignment of selectedAssignments) {
    assignmentByStep.set(assignment.stepId, assignment.agentId);
  }

  return readySteps
    .map((step) => {
      const agentId = assignmentByStep.get(step.stepId);
      if (!agentId) {
        return undefined;
      }
      return {
        stepId: step.stepId,
        agentId,
      };
    })
    .filter((assignment): assignment is AgentAssignment => Boolean(assignment));
}

function parseAgentAssignments(
  input: Record<string, unknown>,
  stepIds: Set<string>,
  availableAgentIds: Set<string>,
): AgentAssignment[] {
  const rawAssignments = input.assignments;
  if (!Array.isArray(rawAssignments)) {
    return [];
  }

  const parsed: AgentAssignment[] = [];

  for (const item of rawAssignments) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const stepId =
      typeof (item as { stepId?: unknown }).stepId === "string"
        ? (item as { stepId: string }).stepId
        : undefined;
    const agentId =
      typeof (item as { agentId?: unknown }).agentId === "string"
        ? (item as { agentId: string }).agentId
        : undefined;

    if (!stepId || !agentId) {
      continue;
    }

    if (!stepIds.has(stepId)) {
      continue;
    }

    if (!availableAgentIds.has(agentId)) {
      continue;
    }

    if (!BuiltinAgentRegistry.has(agentId)) {
      continue;
    }

    parsed.push({ stepId, agentId });
  }

  return parsed;
}

async function requestFailureDecision(
  objective: string,
  failedStep: {
    stepId: string;
    error: string;
    attempts: number;
  },
  hybridRuntime: DispatchHybridRuntime,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<FailureDecision> {
  const fallbackDecision: FailureDecision = {
    action: failedStep.attempts <= 1 ? "retry" : "skip",
    reasoning:
      failedStep.attempts <= 1
        ? "Retry once before skipping"
        : "Skip after repeated failure",
  };

  let selectedDecision = fallbackDecision;

  const decisionToolExecutor: ToolExecutor = {
    async execute(calls: Tool.Call[]): Promise<Tool.Result[]> {
      return calls.map((call) => {
        if (call.tool !== HANDLE_FAILURE_TOOL) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Unsupported supervisor tool: ${call.tool}`,
            isError: true,
          };
        }

        selectedDecision = parseFailureDecision(call.input, fallbackDecision);

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify({ decision: selectedDecision }),
          isError: false,
        };
      });
    },
  };

  const prompt = [
    "Handle failed dispatch step execution.",
    "Call handle_failure with { action, reasoning }.",
    `Objective: ${objective}`,
    `Failed Step: ${JSON.stringify(failedStep)}`,
    `Options: ${JSON.stringify(["retry", "skip", "replan"])}`,
  ].join("\n\n");

  await runSupervisorToolDecision(
    prompt,
    [HANDLE_FAILURE_TOOL],
    decisionToolExecutor,
    hybridRuntime,
    context,
    abortSignal,
  );

  return selectedDecision;
}

function parseFailureDecision(
  input: Record<string, unknown>,
  fallbackDecision: FailureDecision,
): FailureDecision {
  const actionRaw = input.action;
  const reasoningRaw = input.reasoning;

  const action: FailureAction =
    actionRaw === "retry" || actionRaw === "skip" || actionRaw === "replan"
      ? actionRaw
      : fallbackDecision.action;

  const reasoning =
    typeof reasoningRaw === "string" && reasoningRaw.trim().length > 0
      ? reasoningRaw.trim()
      : fallbackDecision.reasoning;

  return {
    action,
    reasoning,
  };
}

async function runSupervisorToolDecision(
  prompt: string,
  tools: string[],
  toolExecutor: ToolExecutor,
  hybridRuntime: DispatchHybridRuntime,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }

  const decisionTask = TaskManager.create(
    {
      title: "Dispatch supervisor decision",
      description: prompt,
      owner: { type: "agent", id: hybridRuntime.supervisorAgentId },
      triggers: [{ id: SUPERVISOR_DECISION_TRIGGER_ID, type: "manual" }],
    },
    { intent: "run_tracking" },
  );

  const spawnedBy =
    context.parentTaskId && context.parentRunId && context.parentSessionId
      ? {
          taskId: context.parentTaskId,
          runId: context.parentRunId,
          sessionId: context.parentSessionId,
        }
      : undefined;

  const triggerResult = await TaskManager.trigger(decisionTask.id, {
    triggerId: SUPERVISOR_DECISION_TRIGGER_ID,
    type: "manual",
    occurredAt: Date.now(),
    spawnedBy,
  });

  if ("error" in triggerResult) {
    return;
  }

  const config: OrchestratorConfig = {
    taskId: decisionTask.id,
    runId: triggerResult.runId,
    maxRetries: 0,
    sessionMode: "ephemeral",
    maxSubagentDepth: context.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    currentDepth: context.parentDepth ?? 0,
    insideDelegation: true,
  };

  const orchestratorInput: OrchestratorRunInput = {
    llm: hybridRuntime.supervisorLLM,
    input: {
      system: hybridRuntime.supervisorSystemPrompt,
      systemPrompt: hybridRuntime.supervisorSystemPrompt,
      prompt,
      agentType: hybridRuntime.supervisorAgent.name,
      tools,
      permissions: hybridRuntime.supervisorAgent.permissions,
      maxTurns: hybridRuntime.supervisorAgent.maxTurns,
    },
    toolExecutor,
  };

  await executeChildRunWithAbort(config, orchestratorInput, abortSignal);
}

async function resolveWorkerRuntimeForTask(
  agentId: string,
  context: DispatchContext,
  hybridRuntime?: DispatchHybridRuntime,
  workerRuntimeCache?: Map<string, Promise<WorkerRuntimeConfig | undefined>>,
): Promise<WorkerRuntimeConfig | undefined> {
  const cached = workerRuntimeCache?.get(agentId);
  if (cached) {
    return cached;
  }

  const pending = resolveWorkerRuntimeForTaskInternal(
    agentId,
    context,
    hybridRuntime,
  );
  workerRuntimeCache?.set(agentId, pending);
  return pending;
}

async function resolveWorkerRuntimeForTaskInternal(
  agentId: string,
  context: DispatchContext,
  hybridRuntime?: DispatchHybridRuntime,
): Promise<WorkerRuntimeConfig | undefined> {
  const agent = BuiltinAgentRegistry.get(agentId);
  if (!agent) {
    return undefined;
  }

  const fallbackToolExecutor = context.toolExecutor;

  if (!hybridRuntime) {
    return {
      agent,
      llm: context.llm,
      toolExecutor: fallbackToolExecutor,
      systemPrompt: agent.systemPrompt,
    };
  }

  const upstreamExecutor = context.toolExecutor
    ? createFilteredToolExecutor(agent.tools, context.toolExecutor)
    : undefined;

  if (!agent.model) {
    return {
      agent,
      llm: context.llm,
      toolExecutor: upstreamExecutor,
      systemPrompt: agent.systemPrompt,
    };
  }

  try {
    const resolved = await resolveAgentForWorker(agentId);
    const systemPrompt =
      typeof resolved.input.system === "string" &&
      resolved.input.system.trim().length > 0
        ? resolved.input.system
        : agent.systemPrompt;

    return {
      agent,
      llm: resolved.llm,
      toolExecutor: upstreamExecutor ?? resolved.toolExecutor,
      systemPrompt,
    };
  } catch (error) {
    console.warn(
      "[ExecutionSupervisor] Worker agent resolution failed for",
      agentId,
      "- falling back to context.llm. Error:",
      error,
    );
    return {
      agent,
      llm: context.llm,
      toolExecutor: fallbackToolExecutor,
      systemPrompt: agent.systemPrompt,
    };
  }
}

function createFilteredToolExecutor(
  allowedTools: string[],
  upstream: ToolExecutor,
): ToolExecutor {
  const allowed = new Set(allowedTools);

  return {
    async execute(calls: Tool.Call[]): Promise<Tool.Result[]> {
      const allowedCalls: Tool.Call[] = [];
      const blockedResultByCallId = new Map<string, Tool.Result>();

      for (const call of calls) {
        if (!allowed.has(call.tool)) {
          blockedResultByCallId.set(call.id, {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Tool '${call.tool}' is not allowed for this agent`,
            isError: true,
          });
          continue;
        }
        allowedCalls.push(call);
      }

      const upstreamResults =
        allowedCalls.length > 0 ? await upstream.execute(allowedCalls) : [];
      const upstreamByCallId = new Map(
        upstreamResults.map((result) => [result.toolCallId, result]),
      );

      return calls.map((call) => {
        const blocked = blockedResultByCallId.get(call.id);
        if (blocked) {
          return blocked;
        }

        const upstreamResult = upstreamByCallId.get(call.id);
        if (upstreamResult) {
          return upstreamResult;
        }

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `No tool result returned for '${call.tool}'`,
          isError: true,
        };
      });
    },
  };
}

function completeTaskAndUnblockDependents(
  graph: DependencyGraph,
  taskId: string,
  completed: Set<string>,
  ready: Set<string>,
): void {
  const state = graph.states.get(taskId);
  if (!state) {
    return;
  }

  state.status = "completed";
  state.rejectionStreak = 0;
  completed.add(taskId);

  const dependents = graph.dependents.get(taskId) ?? new Set<string>();
  for (const dependentTaskId of dependents) {
    const remaining = graph.pendingDependencies.get(dependentTaskId);
    remaining?.delete(taskId);
    if (remaining && remaining.size === 0) {
      ready.add(dependentTaskId);
    }
  }
}

function getDispatchRuntime(
  config: ExecutionSupervisorConfig,
): ExecutionSupervisorRuntime | undefined {
  return (config as ExecutionSupervisorConfigInternal).__dispatchRuntime;
}

function buildDispatchInputFromSteps(
  objective: string,
  steps: ExecutionPlanStep[],
  dispatchTasksByStepId?: Map<string, DispatchTask>,
): DispatchExecutionInput {
  const selectedStepIds = new Set(steps.map((step) => step.stepId));

  const tasks = steps.map((step) => {
    const mappedTask = dispatchTasksByStepId?.get(step.stepId);
    if (mappedTask) {
      return {
        ...mappedTask,
        suggestedAgent: step.suggestedAgent ?? mappedTask.suggestedAgent,
        dependencies: mappedTask.dependencies.filter((dependencyId) =>
          selectedStepIds.has(dependencyId),
        ),
      };
    }

    return {
      id: step.stepId,
      description: step.description,
      agentType: "implement",
      suggestedAgent: step.suggestedAgent,
      dependencies: step.dependsOn.filter((dependencyId) =>
        selectedStepIds.has(dependencyId),
      ),
      fileScope: [],
    };
  });

  return {
    objective,
    tasks,
  };
}

function buildDependencyGraph(tasks: DispatchTask[]): DependencyGraph {
  const states = new Map<string, DispatchTaskState>();
  const pendingDependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (states.has(task.id)) {
      throw new Error(`Duplicate task id in dispatch input: ${task.id}`);
    }

    const agent = BuiltinAgentRegistry.get(task.agentType);
    if (!agent) {
      throw new Error(
        `Unknown agent type in dispatch task "${task.id}": ${task.agentType}`,
      );
    }

    states.set(task.id, {
      task,
      childTaskId: "",
      status: "pending",
      sessionId: "",
      agentInstanceId: "",
      agentHistory: [],
      attempts: 0,
      rejectionStreak: 0,
      totalRejections: 0,
      handoffs: 0,
      summaries: [],
      feedbackHistory: [],
      errors: [],
    });
    pendingDependencies.set(task.id, new Set(task.dependencies));
    dependents.set(task.id, new Set<string>());
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!states.has(dependencyId)) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${dependencyId}"`,
        );
      }

      const dependencyDependents = dependents.get(dependencyId);
      if (!dependencyDependents) {
        continue;
      }
      dependencyDependents.add(task.id);
    }
  }

  assertAcyclicDependencyGraph(pendingDependencies, dependents);

  return {
    states,
    pendingDependencies,
    dependents,
  };
}

function assertAcyclicDependencyGraph(
  pendingDependencies: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
): void {
  const inDegree = new Map<string, number>();
  for (const [taskId, deps] of pendingDependencies.entries()) {
    inDegree.set(taskId, deps.size);
  }

  const queue: string[] = [];
  for (const [taskId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    visited += 1;
    const currentDependents = dependents.get(current) ?? new Set<string>();
    for (const dependent of currentDependents) {
      const degree = inDegree.get(dependent);
      if (degree === undefined) {
        continue;
      }

      const nextDegree = degree - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (visited !== pendingDependencies.size) {
    throw new Error("Dispatch task dependency graph contains a cycle");
  }
}

function initializeTaskStates(graph: DependencyGraph, objective: string): void {
  for (const state of graph.states.values()) {
    const agent = BuiltinAgentRegistry.get(state.task.agentType);
    if (!agent) {
      throw new Error(
        `Agent type "${state.task.agentType}" is not registered for task "${state.task.id}"`,
      );
    }

    state.agentInstanceId = createAgentInstanceId(state.task.id);
    state.agentHistory.push(state.agentInstanceId);
    state.sessionId = createSessionId(state.task.id);
    ensurePersistentSession(
      state.sessionId,
      `${objective}: ${state.task.id}`,
      agent.name,
    );
    state.childTaskId = createChildTask(state.task, state.agentInstanceId);
  }
}

function createSessionId(taskId: string): string {
  return `agent:${taskId}:subagent:${crypto.randomUUID()}`;
}

function createAgentInstanceId(taskId: string): string {
  return `dispatch-agent:${taskId}:${crypto.randomUUID()}`;
}

function ensurePersistentSession(
  sessionId: string,
  title: string,
  agentName: string,
): void {
  if (Session.get(sessionId)) {
    return;
  }

  const now = Date.now();
  const session: Session.Info = {
    id: sessionId,
    title,
    model: {
      providerID: "agent",
      modelID: agentName,
    },
    time: {
      created: now,
      updated: now,
    },
  };

  Session.storage.set(session.id, session);
}

function createChildTask(task: DispatchTask, agentInstanceId: string): string {
  const childTask = TaskManager.create(
    {
      title: `Dispatch: ${task.id}`,
      description: task.description,
      owner: { type: "agent", id: agentInstanceId },
      triggers: [{ id: "dispatch-trigger", type: "manual" }],
    },
    { intent: "run_tracking" },
  );

  return childTask.id;
}

async function dispatchReadyTasks(
  objective: string,
  graph: DependencyGraph,
  ready: Set<string>,
  running: Map<string, RunningTask>,
  context: DispatchContext,
  abortSignal: AbortSignal,
  hybridRuntime?: DispatchHybridRuntime,
  workerRuntimeCache?: Map<string, Promise<WorkerRuntimeConfig | undefined>>,
): Promise<void> {
  for (const taskId of Array.from(ready)) {
    if (running.has(taskId)) {
      continue;
    }

    const state = graph.states.get(taskId);
    if (!state || state.status === "completed" || state.status === "failed") {
      ready.delete(taskId);
      continue;
    }

    const pending = graph.pendingDependencies.get(taskId);
    if (pending && pending.size > 0) {
      ready.delete(taskId);
      continue;
    }

    const runningTask = await startTaskRun(
      objective,
      state,
      context,
      abortSignal,
      hybridRuntime,
      workerRuntimeCache,
    );

    if (!runningTask) {
      continue;
    }

    state.status = "running";
    running.set(taskId, runningTask);
    ready.delete(taskId);
  }
}

async function startTaskRun(
  objective: string,
  state: DispatchTaskState,
  context: DispatchContext,
  abortSignal: AbortSignal,
  hybridRuntime?: DispatchHybridRuntime,
  workerRuntimeCache?: Map<string, Promise<WorkerRuntimeConfig | undefined>>,
): Promise<RunningTask | undefined> {
  if (abortSignal.aborted) {
    return undefined;
  }

  const lockOwner = state.agentInstanceId;
  const lockedFiles = normalizeFileScope(state.task.fileScope);

  if (!acquireFileLocks(lockedFiles, lockOwner)) {
    return undefined;
  }

  state.attempts += 1;

  const spawnedBy =
    context.parentTaskId && context.parentRunId && context.parentSessionId
      ? {
          taskId: context.parentTaskId,
          runId: context.parentRunId,
          sessionId: context.parentSessionId,
        }
      : undefined;

  const triggerResult = await TaskManager.trigger(state.childTaskId, {
    triggerId: "dispatch-trigger",
    type: "manual",
    occurredAt: Date.now(),
    spawnedBy,
  });

  if ("error" in triggerResult) {
    return {
      taskId: state.task.id,
      runId: "",
      lockOwner,
      lockedFiles,
      promise: Promise.resolve({
        runId: "",
        success: false,
        summary: "",
        error: `Failed to create child run: ${triggerResult.error}`,
      }),
    };
  }

  const runId = triggerResult.runId;

  const workerRuntime = await resolveWorkerRuntimeForTask(
    state.task.agentType,
    context,
    hybridRuntime,
    workerRuntimeCache,
  );
  if (!workerRuntime) {
    return {
      taskId: state.task.id,
      runId,
      lockOwner,
      lockedFiles,
      promise: Promise.resolve({
        runId,
        success: false,
        summary: "",
        error: `Agent not found: ${state.task.agentType}`,
      }),
    };
  }

  const prompt = buildExecutionPrompt(objective, state);
  const config: OrchestratorConfig = {
    taskId: state.childTaskId,
    runId,
    maxRetries: 0,
    sessionMode: "reuse",
    sessionId: state.sessionId,
    maxSubagentDepth: context.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    currentDepth: (context.parentDepth ?? 0) + 1,
    insideDelegation: true,
  };

  const orchestratorInput: OrchestratorRunInput = {
    llm: workerRuntime.llm,
    input: {
      system: workerRuntime.systemPrompt,
      systemPrompt: workerRuntime.systemPrompt,
      prompt,
      agentType: workerRuntime.agent.name,
      tools: workerRuntime.agent.tools,
      permissions: workerRuntime.agent.permissions,
      maxTurns: workerRuntime.agent.maxTurns,
    },
    toolExecutor: workerRuntime.toolExecutor,
  };

  const promise = executeChildRunWithAbort(
    config,
    orchestratorInput,
    abortSignal,
  ).then((result) => ({
    runId,
    success: result.success,
    summary: result.summary,
    error: result.error,
  }));

  return {
    taskId: state.task.id,
    runId,
    lockOwner,
    lockedFiles,
    promise,
  };
}

function buildExecutionPrompt(
  objective: string,
  state: DispatchTaskState,
): string {
  const lines: string[] = [
    `Objective: ${objective}`,
    `Task ID: ${state.task.id}`,
    `Task Description: ${state.task.description}`,
    `Attempt: ${state.attempts}`,
  ];

  if (state.task.dependencies.length > 0) {
    lines.push(`Dependencies: ${state.task.dependencies.join(", ")}`);
  }

  if (state.task.fileScope.length > 0) {
    lines.push(`File Scope: ${state.task.fileScope.join(", ")}`);
  }

  if (state.feedbackHistory.length > 0) {
    lines.push(
      `Review Feedback History:\n- ${state.feedbackHistory.join("\n- ")}`,
    );
  }

  if (state.handoffDocument) {
    lines.push(`Handoff Document:\n${state.handoffDocument}`);
  }

  lines.push("Provide a concise completion summary.");

  return lines.join("\n\n");
}

async function executeChildRunWithAbort(
  config: OrchestratorConfig,
  input: OrchestratorRunInput,
  abortSignal: AbortSignal,
): Promise<{ success: boolean; summary: string; error: string }> {
  if (abortSignal.aborted) {
    TaskManager.cancelRun(config.runId, "dispatch_aborted");
    return {
      success: false,
      summary: "",
      error: "Dispatch aborted",
    };
  }

  return new Promise((resolve) => {
    let settled = false;

    const finalize = (result: {
      success: boolean;
      summary: string;
      error: string;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      TaskManager.cancelRun(config.runId, "dispatch_aborted");
      finalize({
        success: false,
        summary: "",
        error: "Dispatch aborted",
      });
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });

    RunWorker.run(config, input)
      .then((result) => {
        finalize(result);
      })
      .catch((error) => {
        finalize({
          success: false,
          summary: "",
          error: toErrorMessage(error),
        });
      });
  });
}

async function waitForNextResult(
  running: Map<string, RunningTask>,
  abortSignal: AbortSignal,
): Promise<
  | {
      type: "result";
      taskId: string;
      result: ChildRunResult;
      running: RunningTask;
    }
  | {
      type: "aborted";
    }
> {
  const resultPromises = Array.from(running.entries()).map(([taskId, active]) =>
    active.promise.then((result) => ({
      type: "result" as const,
      taskId,
      result,
      running: active,
    })),
  );

  if (abortSignal.aborted) {
    return { type: "aborted" };
  }

  let cleanup = () => {};
  const abortPromise = new Promise<{ type: "aborted" }>((resolve) => {
    const onAbort = () => {
      resolve({ type: "aborted" });
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort);
    };
  });

  try {
    return await Promise.race([...resultPromises, abortPromise]);
  } finally {
    cleanup();
  }
}

async function reviewTaskResult(
  objective: string,
  state: DispatchTaskState,
  result: ChildRunResult,
  context: DispatchContext,
): Promise<DispatchReviewDecision> {
  if (!result.success) {
    return {
      decision: "reject",
      feedback: result.error || "Task execution failed",
    };
  }

  if (!context.review) {
    return defaultReviewDecision(result.summary);
  }

  try {
    return await context.review({
      objective,
      taskId: state.task.id,
      agentId: state.agentInstanceId,
      sessionId: state.sessionId,
      summary: result.summary,
      attempt: state.attempts,
      rejectionStreak: state.rejectionStreak,
      feedbackHistory: [...state.feedbackHistory],
    });
  } catch (error) {
    return {
      decision: "reject",
      feedback: `Review function failed: ${toErrorMessage(error)}`,
    };
  }
}

function defaultReviewDecision(summary: string): DispatchReviewDecision {
  const normalized = summary.trim().toLowerCase();
  if (normalized.startsWith("reject:")) {
    return {
      decision: "reject",
      feedback: summary.slice("reject:".length).trim() || "Result rejected",
    };
  }

  if (normalized === "reject") {
    return {
      decision: "reject",
      feedback: "Result rejected",
    };
  }

  return {
    decision: "accept",
  };
}

async function sendReviewFeedback(
  state: DispatchTaskState,
  runId: string,
  feedback: string,
): Promise<void> {
  await AgentMessenger.send({
    traceId: crypto.randomUUID(),
    sessionId: state.sessionId,
    runId: runId || crypto.randomUUID(),
    fromAgentId: DISPATCH_AGENT_ID,
    toAgentId: state.agentInstanceId,
    sentAt: new Date().toISOString(),
    schemaRef: "dispatch.review.feedback.v1",
    payload: {
      type: "review_feedback",
      taskId: state.task.id,
      feedback,
      rejectionCount: state.totalRejections,
    },
  }).catch(() => {
    return undefined;
  });
}

async function requestHandoffDocument(
  objective: string,
  state: DispatchTaskState,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<string> {
  if (abortSignal.aborted) {
    return "Handoff unavailable: dispatch aborted";
  }

  const agent = BuiltinAgentRegistry.get(state.task.agentType);
  if (!agent) {
    return `Handoff unavailable: unknown agent type ${state.task.agentType}`;
  }

  const handoffSpawnedBy =
    context.parentTaskId && context.parentRunId && context.parentSessionId
      ? {
          taskId: context.parentTaskId,
          runId: context.parentRunId,
          sessionId: context.parentSessionId,
        }
      : undefined;

  const triggerResult = await TaskManager.trigger(state.childTaskId, {
    triggerId: "dispatch-trigger",
    type: "manual",
    occurredAt: Date.now(),
    spawnedBy: handoffSpawnedBy,
  });

  if ("error" in triggerResult) {
    return `Handoff unavailable: failed to create handoff run (${triggerResult.error})`;
  }

  const prompt = [
    "Create a handoff document for replacement agent.",
    `Objective: ${objective}`,
    `Task ID: ${state.task.id}`,
    `Task Description: ${state.task.description}`,
    `Attempt Count: ${state.attempts}`,
    `Feedback History:\n- ${state.feedbackHistory.join("\n- ") || "none"}`,
    "Include attempted approach, blockers, and recommended next steps.",
  ].join("\n\n");

  const config: OrchestratorConfig = {
    taskId: state.childTaskId,
    runId: triggerResult.runId,
    maxRetries: 0,
    sessionMode: "reuse",
    sessionId: state.sessionId,
    maxSubagentDepth: context.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    currentDepth: (context.parentDepth ?? 0) + 1,
    insideDelegation: true,
  };

  const orchestratorInput: OrchestratorRunInput = {
    llm: context.llm,
    input: {
      systemPrompt: agent.systemPrompt,
      prompt,
      agentType: agent.name,
      tools: agent.tools,
      permissions: agent.permissions,
      maxTurns: agent.maxTurns,
    },
    toolExecutor: context.toolExecutor,
  };

  const result = await executeChildRunWithAbort(
    config,
    orchestratorInput,
    abortSignal,
  );

  if (!result.success || !result.summary.trim()) {
    return [
      "Handoff summary unavailable from agent.",
      `Latest error: ${result.error || "none"}`,
      `Last summary: ${state.summaries[state.summaries.length - 1] || "none"}`,
      `Feedback:\n- ${state.feedbackHistory.join("\n- ") || "none"}`,
    ].join("\n\n");
  }

  return result.summary;
}

function rotateAgent(state: DispatchTaskState, objective: string): void {
  const agent = BuiltinAgentRegistry.get(state.task.agentType);
  if (!agent) {
    state.errors.push(
      `Unable to rotate agent: ${state.task.agentType} not found`,
    );
    state.status = "failed";
    return;
  }

  state.handoffs += 1;
  state.rejectionStreak = 0;
  state.agentInstanceId = createAgentInstanceId(state.task.id);
  state.agentHistory.push(state.agentInstanceId);

  state.sessionId = createSessionId(state.task.id);
  ensurePersistentSession(
    state.sessionId,
    `${objective}: ${state.task.id} (handoff)`,
    agent.name,
  );
  state.childTaskId = createChildTask(state.task, state.agentInstanceId);
}

function normalizeFileScope(fileScope: string[]): string[] {
  return Array.from(
    new Set(fileScope.filter((path) => path.trim().length > 0)),
  );
}

function acquireFileLocks(files: string[], agentId: string): boolean {
  const acquired: string[] = [];

  for (const file of files) {
    if (!FileLock.acquire(file, agentId)) {
      releaseFileLocks(acquired, agentId);
      return false;
    }
    acquired.push(file);
  }

  return true;
}

function releaseFileLocks(files: string[], agentId: string): void {
  for (const file of files) {
    FileLock.release(file, agentId);
  }
}

function cancelRunningChildren(
  running: Map<string, RunningTask>,
  reason: string,
): void {
  for (const active of running.values()) {
    if (active.runId) {
      TaskManager.cancelRun(active.runId, reason);
    }
    releaseFileLocks(active.lockedFiles, active.lockOwner);
  }
  running.clear();
}

function markPendingAsFailed(graph: DependencyGraph, error: string): void {
  for (const state of graph.states.values()) {
    if (state.status === "completed") {
      continue;
    }
    state.status = "failed";
    state.errors.push(error);
  }
}

function buildOutput(
  objective: string,
  graph: DependencyGraph,
  startedAt: number,
  success: boolean,
  error?: string,
): DispatchOutput {
  const results = Array.from(graph.states.values()).map((state) => ({
    id: state.task.id,
    childTaskId: state.childTaskId,
    status: state.status,
    attempts: state.attempts,
    rejections: state.totalRejections,
    handoffs: state.handoffs,
    sessionId: state.sessionId,
    agentHistory: [...state.agentHistory],
    summary: state.summaries[state.summaries.length - 1],
    error: state.errors[state.errors.length - 1],
  }));

  return {
    success,
    objective,
    durationMs: Date.now() - startedAt,
    completedTaskIds: results
      .filter((result) => result.status === "completed")
      .map((result) => result.id),
    results,
    error,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
