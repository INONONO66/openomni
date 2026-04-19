import { ChatAgent } from "@openomni/agent";
import { type Execution, Subagent } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import {
  type AgentToolProvider,
  PlanToolProvider,
  SessionBridge,
  SystemToolProvider,
  TaskToolProvider,
  TodoToolProvider,
  buildWorkerMiddleware,
  type CoordinatorLike,
  runPlan,
} from "@openomni/openomni";
import type { McpToolProvider } from "../tool/mcp";
import type { CustomToolProvider } from "../tool/custom";
import { createExecutionToolContext } from "../execution/worker-runtime";
import { createContextMiddleware, ContextAssembler } from "../context/index";

type Config = {
  readonly systemProvider: SystemToolProvider;
  readonly agentProvider: AgentToolProvider;
  readonly mcpProvider: McpToolProvider;
  readonly customProvider?: CustomToolProvider;
  readonly workspaceRoot?: string;
};

export namespace LocalRunner {
  export function create(config: Config): CoordinatorLike {
    return {
      dispatch: (_sessionTreeId, request) => run(config, request),
    };
  }
}

async function run(config: Config, request: Execution.Request): Promise<Execution.Result> {
  const { runId, sessionId } = request;

  Bus.publish(Subagent.Events.WorkerRunStarted, {
    traceId: crypto.randomUUID(),
    sessionId,
    runId,
    time: Date.now(),
    payload: { sessionId, runId, title: request.prompt.slice(0, 80) },
  });

  try {
    const result =
      request.mode === "direct"
        ? await runDirect(config, request)
        : await executePlan(config, request);

    Bus.publish(Subagent.Events.WorkerRunCompleted, {
      traceId: crypto.randomUUID(),
      sessionId,
      runId,
      time: Date.now(),
      payload: { sessionId, runId, status: result.status as Subagent.WorkerRunStatus },
    });

    return result;
  } catch (err) {
    Bus.publish(Subagent.Events.WorkerRunFailed, {
      traceId: crypto.randomUUID(),
      sessionId,
      runId,
      time: Date.now(),
      payload: {
        sessionId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

async function runDirect(config: Config, request: Execution.Request): Promise<Execution.Result> {
  const messages = SessionBridge.buildDirectMessages(request.sessionId).filter(
    (m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
      m.role === "user" || m.role === "assistant",
  );

  const workspaceRoot =
    request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? config.workspaceRoot;
  const systemProvider = new SystemToolProvider(workspaceRoot);
  const taskProvider = new TaskToolProvider();
  const planProvider = new PlanToolProvider();
  const todoProvider = new TodoToolProvider();

  const availableTools = [
    ...systemProvider.listTools(),
    ...config.agentProvider.listTools(),
    ...config.mcpProvider.listTools(),
    ...(config.customProvider?.listTools() ?? []),
    ...taskProvider.listTools(),
    ...planProvider.listTools(),
    ...todoProvider.listTools(),
  ];

  const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);

  const agent = ChatAgent.create({
    model: request.model,
    systemPrompt: request.systemPrompt,
    budget: request.budget,
    tools,
    toolExecutor,
    middleware: [
      createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
      ...buildWorkerMiddleware({
        permissions: request.permissions,
        budget: request.budget,
      }),
    ],
  });

  const runResult = await agent.run({ messages });

  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded",
    output: runResult.text,
    finishReason: runResult.finishReason,
  };
}

async function executePlan(config: Config, request: Execution.Request): Promise<Execution.Result> {
  const { runId, sessionId } = request;
  const workspaceRoot =
    request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? config.workspaceRoot;
  const systemProvider = new SystemToolProvider(workspaceRoot);
  const taskProvider = new TaskToolProvider();
  const planProvider = new PlanToolProvider();
  const todoProvider = new TodoToolProvider();

  const availableTools = [
    ...systemProvider.listTools(),
    ...config.agentProvider.listTools(),
    ...config.mcpProvider.listTools(),
    ...(config.customProvider?.listTools() ?? []),
    ...taskProvider.listTools(),
    ...planProvider.listTools(),
    ...todoProvider.listTools(),
  ];

  const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);
  const goal = await SessionBridge.buildPlanGoal(sessionId);
  const planContext = ContextAssembler.assemble({ workspaceRoot: workspaceRoot ?? process.cwd() });
  const planSystemPrompt = planContext
    ? `${request.systemPrompt}\n\n${planContext}`
    : request.systemPrompt;
  const planResult = await runPlan(goal, {
    model: request.model,
    systemPrompt: planSystemPrompt,
    planSubAdapter: Storage.get().plan!,
    planId: runId,
    budget: request.budget,
    tools,
    toolExecutor,
  });

  return {
    runId,
    sessionId,
    status: "succeeded",
    output: JSON.stringify(planResult),
  };
}
