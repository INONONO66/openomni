import { ChatAgent } from "@openomni/agent";
import { type Execution, Subagent } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  type AgentToolProvider,
  PlanAgent,
  PlanToolProvider,
  SessionBridge,
  SystemToolProvider,
  TaskToolProvider,
  TodoToolProvider,
  buildWorkerMiddleware,
  type CoordinatorLike,
} from "@openomni/openomni";
import type { McpToolProvider } from "../tool/mcp";
import type { CustomToolProvider } from "../tool/custom";
import { createExecutionToolContext } from "../execution/worker-runtime";

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
      request.mode === "direct" ? await runDirect(config, request) : await runPlan(request);

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
    middleware: buildWorkerMiddleware({
      permissions: request.permissions,
      budget: request.budget,
    }),
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

async function runPlan(request: Execution.Request): Promise<Execution.Result> {
  const goal = SessionBridge.buildPlanGoal(request.sessionId);
  const result = await PlanAgent.generate(goal, {
    model: request.model,
    systemPrompt: request.systemPrompt,
    budget: request.budget,
  });

  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded",
    output: JSON.stringify(result),
  };
}
