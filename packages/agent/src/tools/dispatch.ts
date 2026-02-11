import type { ToolResult } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { AgentMessenger } from "../agent/communication";
import { BuiltinAgentRegistry } from "../agent/registry";
import type {
  OrchestratorConfig,
  OrchestratorRunInput,
} from "../loop/orchestration";
import { RunWorker } from "../loop/run-worker";
import { TaskManager } from "../task/manager";
import { DispatchInput } from "./schemas";

const DEFAULT_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const MAX_REJECTIONS_BEFORE_HANDOFF = 3;
const DISPATCH_AGENT_ID = "dispatch-supervisor";

type DispatchTask = DispatchInput["tasks"][number];

type TaskStatus = "pending" | "running" | "completed" | "failed";

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
  timeoutMs?: number;
  review?: (
    input: DispatchReviewInput,
  ) => DispatchReviewDecision | Promise<DispatchReviewDecision>;
  parentTaskId?: string;
  parentRunId?: string;
  parentSessionId?: string;
}

interface DispatchTaskState {
  task: DispatchTask;
  childTaskId: string;
  status: TaskStatus;
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

interface DispatchOutput {
  success: boolean;
  objective: string;
  durationMs: number;
  completedTaskIds: string[];
  results: Array<{
    id: string;
    status: TaskStatus;
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

export namespace FileLock {
  const locks = new Map<string, string>();

  export function acquire(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (owner && owner !== agentId) {
      return false;
    }
    locks.set(filePath, agentId);
    return true;
  }

  export function release(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (!owner || owner !== agentId) {
      return false;
    }
    locks.delete(filePath);
    return true;
  }

  export function owner(filePath: string): string | undefined {
    return locks.get(filePath);
  }

  export function clear(): void {
    locks.clear();
  }
}

export namespace Dispatch {
  export async function execute(
    toolCallId: string,
    rawInput: unknown,
    context: DispatchContext,
  ): Promise<ToolResult> {
    const parseResult = DispatchInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Invalid dispatch input: ${parseResult.error.message}`,
        isError: true,
      };
    }

    const input = parseResult.data;

    try {
      const output = await executeDispatch(input, context);
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: JSON.stringify(output),
        isError: !output.success,
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Dispatch execution error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}

async function executeDispatch(
  input: DispatchInput,
  context: DispatchContext,
): Promise<DispatchOutput> {
  const startedAt = Date.now();
  const graph = buildDependencyGraph(input.tasks);

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
    await dispatchReadyTasks(
      input.objective,
      graph,
      ready,
      running,
      context,
      dispatchAbortController.signal,
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

      await dispatchReadyTasks(
        input.objective,
        graph,
        ready,
        running,
        context,
        dispatchAbortController.signal,
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

      const reviewDecision = await reviewTaskResult(
        input.objective,
        state,
        next.result,
        context,
      );

      if (reviewDecision.decision === "accept") {
        state.status = "completed";
        state.rejectionStreak = 0;
        completed.add(state.task.id);

        const dependents =
          graph.dependents.get(state.task.id) ?? new Set<string>();
        for (const dependentTaskId of dependents) {
          const remaining = graph.pendingDependencies.get(dependentTaskId);
          remaining?.delete(state.task.id);
          if (remaining && remaining.size === 0) {
            ready.add(dependentTaskId);
          }
        }

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
  const childTask = TaskManager.create({
    title: `Dispatch: ${task.id}`,
    description: task.description,
    owner: { type: "agent", id: agentInstanceId },
    triggers: [{ id: "dispatch-trigger", type: "manual" }],
  });

  return childTask.id;
}

async function dispatchReadyTasks(
  objective: string,
  graph: DependencyGraph,
  ready: Set<string>,
  running: Map<string, RunningTask>,
  context: DispatchContext,
  abortSignal: AbortSignal,
): Promise<void> {
  for (const taskId of Array.from(ready)) {
    if (running.has(taskId)) {
      continue;
    }

    const state = graph.states.get(taskId);
    if (!state || state.status === "completed") {
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

  const agent = BuiltinAgentRegistry.get(state.task.agentType);
  if (!agent) {
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
