import type { Tool } from "@openomni/protocol";
import { BuiltinAgentRegistry } from "../../agent";
import { resolveAgentDefinition, resolveAgentForWorker } from "../../worker";
import type {
  AgentAssignment,
  DependencyGraph,
  DispatchContext,
  DispatchHybridRuntime,
  DispatchTask,
  DispatchTaskState,
  ReadyStepDescriptor,
  WorkerRuntimeConfig,
} from "../execution-types";
import type { ToolExecutor } from "../../worker";

const ASSIGN_AGENTS_TOOL = "assign_agents";

export type RunSupervisorToolDecision = (
  prompt: string,
  tools: string[],
  toolExecutor: ToolExecutor,
  hybridRuntime: DispatchHybridRuntime,
  context: DispatchContext,
  abortSignal: AbortSignal,
) => Promise<void>;

export async function resolveDispatchHybridRuntime(
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

export async function assignAgentsToReadyTasks(
  objective: string,
  graph: DependencyGraph,
  ready: Set<string>,
  hybridRuntime: DispatchHybridRuntime | undefined,
  context: DispatchContext,
  abortSignal: AbortSignal,
  runSupervisorToolDecision: RunSupervisorToolDecision,
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
    runSupervisorToolDecision,
  );

  const assignmentByStep = new Map(
    assignments.map((assignment) => [assignment.stepId, assignment.agentId]),
  );

  for (const state of readyStates) {
    const fallbackAgent = resolveFallbackAgentAssignment(state.task, hybridRuntime.availableAgents);
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

export function resolveFallbackAgentAssignment(
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

  if (availableAgents.includes(task.agentType) && BuiltinAgentRegistry.has(task.agentType)) {
    return task.agentType;
  }

  return availableAgents.find((agentId) => BuiltinAgentRegistry.has(agentId));
}

export async function resolveWorkerRuntimeForTask(
  agentId: string,
  context: DispatchContext,
  hybridRuntime?: DispatchHybridRuntime,
  workerRuntimeCache?: Map<string, Promise<WorkerRuntimeConfig | undefined>>,
): Promise<WorkerRuntimeConfig | undefined> {
  const cached = workerRuntimeCache?.get(agentId);
  if (cached) {
    return cached;
  }

  const pending = resolveWorkerRuntimeForTaskInternal(agentId, context, hybridRuntime);
  workerRuntimeCache?.set(agentId, pending);
  return pending;
}

async function requestAgentAssignments(
  objective: string,
  readySteps: ReadyStepDescriptor[],
  hybridRuntime: DispatchHybridRuntime,
  context: DispatchContext,
  abortSignal: AbortSignal,
  runSupervisorToolDecision: RunSupervisorToolDecision,
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

        const parsed = parseAgentAssignments(call.input, stepIds, availableAgentIds);
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
    fallbackAssignments.map((assignment) => [assignment.stepId, assignment.agentId]),
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

function resolveAvailableAgentIds(availableAgents?: string[]): string[] {
  const registeredAgentIds = new Set(BuiltinAgentRegistry.list().map((agent) => agent.name));

  if (availableAgents && availableAgents.length > 0) {
    return Array.from(
      new Set(availableAgents.filter((agentId) => registeredAgentIds.has(agentId))),
    );
  }

  return Array.from(registeredAgentIds);
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
      typeof resolved.input.system === "string" && resolved.input.system.trim().length > 0
        ? resolved.input.system.trim()
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

function createFilteredToolExecutor(allowedTools: string[], upstream: ToolExecutor): ToolExecutor {
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

      const upstreamResults = allowedCalls.length > 0 ? await upstream.execute(allowedCalls) : [];
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
