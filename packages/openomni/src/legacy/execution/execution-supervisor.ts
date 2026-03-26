import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../agent";
import { TaskManager } from "../task";
import {
  assignAgentsToReadyTasks,
  resolveDispatchHybridRuntime,
  resolveWorkerRuntimeForTask,
  buildDependencyGraph,
  completeTaskAndUnblockDependents,
  FileLock,
} from "./graph";
import {
  decideFailedStepAction,
  requestHandoffDocument,
  reviewTaskResult,
  rotateAgent,
  sendReviewFeedback,
} from "./execution-review";
import type {
  ChildRunResult,
  DependencyGraph,
  DispatchContext,
  DispatchExecutionInput,
  DispatchHybridRuntime,
  DispatchOutput,
  DispatchReviewDecision,
  DispatchTask,
  DispatchTaskState,
  ExecutionPlan,
  ExecutionPlanStep,
  ExecutionSupervisorConfig,
  ExecutionSupervisorConfigInternal,
  ExecutionSupervisorResult,
  ExecutionSupervisorRuntime,
  FailureDecision,
  RunningTask,
  StepOutcome,
  SupervisorDecision,
  WorkerRuntimeConfig,
} from "./execution-types";
import type { OrchestratorConfig, OrchestratorRunInput, ToolExecutor } from "../worker";
import { RunWorker } from "../worker";

const DEFAULT_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const MAX_REJECTIONS_BEFORE_HANDOFF = 3;
const SUPERVISOR_DECISION_TRIGGER_ID = "dispatch-supervisor-trigger";

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
  export async function run(config: ExecutionSupervisorConfig): Promise<ExecutionSupervisorResult> {
    const stepOutcomes: StepOutcome[] = [];

    while (true) {
      const decision = await plan(config, stepOutcomes);

      if (decision === "finish") {
        break;
      }

      const selectedSteps = select(config.plan, stepOutcomes, decision);

      if (selectedSteps.length === 0) {
        break;
      }

      // ┌─────────────────────────────────────────────────────────┐
      // │ WORKER INVOCATION BOUNDARY                              │
      // │ Everything below this point is RunWorker's              │
      // │ responsibility. ExecutionSupervisor MUST NOT execute    │
      // │ LLM calls or tool loops directly.                       │
      // └─────────────────────────────────────────────────────────┘
      const outcomes = await delegate(decision, selectedSteps, config);
      stepOutcomes.push(...outcomes);
    }

    const completedStepIds = new Set(stepOutcomes.map((o) => o.stepId));
    const unexecutedSteps = config.plan.steps.filter((s) => !completedStepIds.has(s.stepId));
    const allStepsExecuted = unexecutedSteps.length === 0;
    const allSucceeded = allStepsExecuted && stepOutcomes.every((o) => o.success);

    const errors: string[] = stepOutcomes
      .filter((o) => !o.success)
      .map((o) => o.error)
      .filter((e): e is string => !!e);

    if (!allStepsExecuted) {
      errors.push(
        `Unexecuted steps (unsatisfiable dependencies): ${unexecutedSteps.map((s) => s.stepId).join(", ")}`,
      );
    }

    return {
      success: allSucceeded,
      summary: stepOutcomes.map((o) => o.summary).join("\n") || "No work executed.",
      error: errors.length > 0 ? errors.join("; ") : undefined,
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
        !completedIds.has(step.stepId) && step.dependsOn.every((dep) => completedIds.has(dep)),
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
      ...(config.availableAgents ? { availableAgents: [...config.availableAgents] } : {}),
    };

    const output = await executeDispatchGraph(input, dispatchContext);
    const resultById = new Map(output.results.map((result) => [result.id, result]));

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
  const workerRuntimeCache = new Map<string, Promise<WorkerRuntimeConfig | undefined>>();

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
      runSupervisorToolDecision,
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
          abortReason === "timeout" ? "dispatch_timeout" : "dispatch_parent_aborted",
        );
        markPendingAsFailed(
          graph,
          abortReason === "timeout" ? "Dispatch timed out" : "Dispatch aborted by parent",
        );
        return buildOutput(
          input.objective,
          graph,
          startedAt,
          false,
          abortReason === "timeout" ? "Dispatch timed out" : "Dispatch aborted by parent",
        );
      }

      await assignAgentsToReadyTasks(
        input.objective,
        graph,
        ready,
        hybridRuntime,
        context,
        dispatchAbortController.signal,
        runSupervisorToolDecision,
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

      const next = await waitForNextResult(running, dispatchAbortController.signal);

      if (next.type === "aborted") {
        cancelRunningChildren(
          running,
          abortReason === "timeout" ? "dispatch_timeout" : "dispatch_parent_aborted",
        );
        markPendingAsFailed(
          graph,
          abortReason === "timeout" ? "Dispatch timed out" : "Dispatch aborted by parent",
        );
        return buildOutput(
          input.objective,
          graph,
          startedAt,
          false,
          abortReason === "timeout" ? "Dispatch timed out" : "Dispatch aborted by parent",
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
          runSupervisorToolDecision,
        );

        if (failureDecision?.action === "skip") {
          if (failureDecision.reasoning.trim().length > 0) {
            state.summaries.push(`Skipped: ${failureDecision.reasoning}`);
          }
          completeTaskAndUnblockDependents(graph, state.task.id, completed, ready);
          continue;
        }

        if (failureDecision?.action === "replan") {
          const reason =
            failureDecision.reasoning.trim() || "Supervisor requested replan for failed step";
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
              feedback: failureDecision.reasoning || next.result.error || "Task execution failed",
            }
          : await reviewTaskResult(input.objective, state, next.result, context);

      if (reviewDecision.decision === "accept") {
        completeTaskAndUnblockDependents(graph, state.task.id, completed, ready);

        continue;
      }

      const feedback =
        reviewDecision.feedback || next.result.error || "Result rejected. Revise and retry.";

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
          executeChildRunWithAbort,
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
      dependencies: step.dependsOn.filter((dependencyId) => selectedStepIds.has(dependencyId)),
      fileScope: [],
    };
  });

  return {
    objective,
    tasks,
  };
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
    ensurePersistentSession(state.sessionId, `${objective}: ${state.task.id}`, agent.name);
    state.childTaskId = createChildTask(state.task, state.agentInstanceId);
  }
}

function createSessionId(taskId: string): string {
  return `agent:${taskId}:subagent:${crypto.randomUUID()}`;
}

function createAgentInstanceId(taskId: string): string {
  return `dispatch-agent:${taskId}:${crypto.randomUUID()}`;
}

function ensurePersistentSession(sessionId: string, title: string, agentName: string): void {
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

  const promise = executeChildRunWithAbort(config, orchestratorInput, abortSignal).then(
    (result) => ({
      runId,
      success: result.success,
      summary: result.summary,
      error: result.error,
    }),
  );

  return {
    taskId: state.task.id,
    runId,
    lockOwner,
    lockedFiles,
    promise,
  };
}

function buildExecutionPrompt(objective: string, state: DispatchTaskState): string {
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
    lines.push(`Review Feedback History:\n- ${state.feedbackHistory.join("\n- ")}`);
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

    const finalize = (result: { success: boolean; summary: string; error: string }) => {
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

function normalizeFileScope(fileScope: string[]): string[] {
  return Array.from(new Set(fileScope.filter((path) => path.trim().length > 0)));
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

function cancelRunningChildren(running: Map<string, RunningTask>, reason: string): void {
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
