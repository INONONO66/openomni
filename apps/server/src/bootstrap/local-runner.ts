import { ChatAgent } from "@openomni/agent";
import type { Execution } from "@openomni/protocol";
import {
  type AgentToolProvider,
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
import { createContextMiddleware } from "../context/index";

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
  const messages = SessionBridge.buildDirectMessages(request.sessionId).filter(
    (m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
      m.role === "user" || m.role === "assistant",
  );

  const workspaceRoot =
    request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? config.workspaceRoot;
  const systemProvider = new SystemToolProvider(workspaceRoot);
  const taskProvider = new TaskToolProvider();
  const todoProvider = new TodoToolProvider();

  const availableTools = [
    ...systemProvider.listTools(),
    ...config.agentProvider.listTools(),
    ...config.mcpProvider.listTools(),
    ...(config.customProvider?.listTools() ?? []),
    ...taskProvider.listTools(),
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
