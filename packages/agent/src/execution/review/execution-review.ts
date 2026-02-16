import type { Tool } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { AgentMessenger, BuiltinAgentRegistry } from "../../agent";
import { TaskManager } from "../../task";
import type { RunSupervisorToolDecision } from "../graph";
import type {
  ChildRunResult,
  DispatchContext,
  DispatchHybridRuntime,
  DispatchReviewDecision,
  DispatchTaskState,
  FailureAction,
  FailureDecision,
} from "../execution-types";
import type {
  OrchestratorConfig,
  OrchestratorRunInput,
  ToolExecutor,
} from "../../worker/run/run-worker";

const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const DISPATCH_AGENT_ID = "dispatch-supervisor";
const HANDLE_FAILURE_TOOL = "handle_failure";

export type ExecuteChildRunWithAbort = (
  config: OrchestratorConfig,
  input: OrchestratorRunInput,
  abortSignal: AbortSignal,
) => Promise<{ success: boolean; summary: string; error: string }>;

export async function decideFailedStepAction(
  objective: string,
  state: DispatchTaskState,
  result: ChildRunResult,
  hybridRuntime: DispatchHybridRuntime | undefined,
  context: DispatchContext,
  abortSignal: AbortSignal,
  runSupervisorToolDecision: RunSupervisorToolDecision,
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
    runSupervisorToolDecision,
  );
}

export async function reviewTaskResult(
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

export async function sendReviewFeedback(
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

export async function requestHandoffDocument(
  objective: string,
  state: DispatchTaskState,
  context: DispatchContext,
  abortSignal: AbortSignal,
  executeChildRunWithAbort: ExecuteChildRunWithAbort,
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

export function rotateAgent(state: DispatchTaskState, objective: string): void {
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
  state.agentInstanceId = `dispatch-agent:${state.task.id}:${crypto.randomUUID()}`;
  state.agentHistory.push(state.agentInstanceId);

  state.sessionId = `agent:${state.task.id}:subagent:${crypto.randomUUID()}`;
  if (!Session.get(state.sessionId)) {
    const now = Date.now();
    const session: Session.Info = {
      id: state.sessionId,
      title: `${objective}: ${state.task.id} (handoff)`,
      model: {
        providerID: "agent",
        modelID: agent.name,
      },
      time: {
        created: now,
        updated: now,
      },
    };

    Session.storage.set(session.id, session);
  }

  const childTask = TaskManager.create(
    {
      title: `Dispatch: ${state.task.id}`,
      description: state.task.description,
      owner: { type: "agent", id: state.agentInstanceId },
      triggers: [{ id: "dispatch-trigger", type: "manual" }],
    },
    { intent: "run_tracking" },
  );

  state.childTaskId = childTask.id;
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
  runSupervisorToolDecision: RunSupervisorToolDecision,
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
