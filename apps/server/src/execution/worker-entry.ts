import { ChatAgent, AgentRegistry } from "@openomni/agent";
import { createIpcServer } from "@openomni/coordinator";
import { Execution, Tool, WorkerBootstrap } from "@openomni/protocol";
import { initialize, Storage } from "@openomni/session";
import {
  AgentToolProvider,
  BackgroundManager,
  ToolProxyProvider,
  PlanToolProvider,
  SessionBridge,
  SystemToolProvider,
  TaskToolProvider,
  TodoToolProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  createWorkerSubagentRuntime,
  runPlan,
} from "@openomni/openomni";
import { loadConfig } from "../config";
import { createExecutionToolContext, resolveWorkerDbPath } from "./worker-runtime";

const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1] ?? "unknown";
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("worker-entry: missing --socket argument");
  process.exit(1);
}

const config = loadConfig();
initialize({
  dbPath: resolveWorkerDbPath(config),
});

let workerBootstrap: WorkerBootstrap.Bootstrap | null = null;
const activeRunIds = new Set<string>();

const backgroundManager = BackgroundManager.create({
  maxConcurrentPerAgent: 3,
  maxConcurrentTotal: 10,
  maxDepth: 3,
});

const server = createIpcServer(socketPath, (method, params, respond) => {
  if (method === "coordinator.spawn_run") {
    let request: Execution.Request;
    try {
      request = Execution.Request.parse(params);
    } catch (err) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const { runId, sessionId } = request;

    (async () => {
      activeRunIds.add(runId);
      server.notify("worker.run_started", { runId, sessionId });

      try {
        if (request.mode === "direct") {
          const messages = SessionBridge.buildDirectMessages(sessionId).filter(
            (m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
              m.role === "user" || m.role === "assistant",
          );
          const workspaceRoot =
            request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? config.workspace?.root;
          const systemProvider = new SystemToolProvider(workspaceRoot);

          const mcpProxyProvider = ToolProxyProvider.create(
            workerBootstrap?.toolCatalog ?? [],
            async (toolName, toolArgs) => {
              const raw = await server.call("worker.tool_call", {
                runId,
                sessionId,
                callId: crypto.randomUUID(),
                tool: toolName,
                input: toolArgs,
              });
              return Tool.Result.parse(raw);
            },
          );

          // toolsRef and catalogRef are filled after createExecutionToolContext so the subagent
          // runtime can apply depth-based tool filtering at spawn time.
          const toolsRef: Parameters<typeof createWorkerSubagentRuntime>[0]["toolsRef"] = {};
          const catalogRef: { catalog?: ReturnType<typeof buildToolCatalog> } = {};
          const agentDefinitionsRef: {
            definitions?: Map<string, WorkerBootstrap.RuntimeAgentDefinition>;
          } = {
            definitions: new Map(
              (workerBootstrap?.agents ?? []).map((agent) => [agent.name, agent]),
            ),
          };

          const agentProvider = new AgentToolProvider({
            subagentRuntime: createWorkerSubagentRuntime({
              toolsRef,
              catalogRef,
              agentDefinitionsRef,
              parentSessionId: sessionId,
              parentPermissions: request.permissions,
            }),
            delegationContext: {
              depth: 0,
              maxDepth: 3,
              visitedAgents: new Set([request.agentName ?? "dev"]),
              parentAbort: new AbortController().signal,
            },
            backgroundManager,
          });

          const taskProvider = new TaskToolProvider();
          const planProvider = new PlanToolProvider();
          const todoProvider = new TodoToolProvider();

          const systemTools = systemProvider.listTools();
          const agentTools = agentProvider.listTools();
          const proxyTools = mcpProxyProvider.listTools();
          const taskTools = taskProvider.listTools();
          const planTools = planProvider.listTools();
          const todoTools = todoProvider.listTools();
          const availableTools = [
            ...systemTools,
            ...agentTools,
            ...proxyTools,
            ...taskTools,
            ...planTools,
            ...todoTools,
          ];
          const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);

          toolsRef.tools = tools;
          toolsRef.toolExecutor = toolExecutor;
          catalogRef.catalog = buildToolCatalog([
            { tools: systemTools, source: "system" },
            { tools: agentTools, source: "agent" },
            { tools: proxyTools, source: "mcp" },
            { tools: taskTools, source: "system" },
            { tools: planTools, source: "system" },
            { tools: todoTools, source: "system" },
          ]);

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

          server.notify("worker.run_completed", {
            runId,
            sessionId,
            status: "succeeded",
            output: runResult.text,
          });

          respond({
            runId,
            sessionId,
            status: "succeeded",
            output: runResult.text,
            finishReason: runResult.finishReason,
          });
        } else {
          const planWorkspaceRoot =
            request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? config.workspace?.root;
          const planSystemProvider = new SystemToolProvider(planWorkspaceRoot);
          const planToolProvider = new PlanToolProvider();
          const planAvailableTools = [
            ...planSystemProvider.listTools(),
            ...planToolProvider.listTools(),
          ];
          const { tools: planTools, toolExecutor: planToolExecutor } = createExecutionToolContext(
            request,
            planAvailableTools,
          );
          const goal = await SessionBridge.buildPlanGoal(sessionId);
          const planResult = await runPlan(goal, {
            model: request.model,
            systemPrompt: request.systemPrompt,
            planSubAdapter: Storage.get().plan!,
            planId: request.runId,
            budget: request.budget,
            tools: planTools,
            toolExecutor: planToolExecutor,
          });

          server.notify("worker.run_completed", { runId, sessionId, status: "succeeded" });

          respond({
            runId,
            sessionId,
            status: "succeeded",
            output: JSON.stringify(planResult),
          });
        }
      } catch (err) {
        server.notify("worker.run_completed", {
          runId,
          sessionId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });

        respond({
          runId,
          sessionId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        activeRunIds.delete(runId);
      }
    })();
  } else if (method === "coordinator.cancel_run") {
    respond({ cancelled: true });
  } else {
    respond({ ok: true });
  }
});

const HEARTBEAT_INTERVAL_MS = 15_000;

setInterval(() => {
  const snapshot: WorkerBootstrap.WorkerSnapshot = {
    activeRuns: [...activeRunIds],
    backgroundTasks: [],
    lastHeartbeat: Date.now(),
    memoryRss: process.memoryUsage().rss / 1024 / 1024,
    configEpoch: workerBootstrap?.configEpoch ?? "",
  };

  server
    .call("worker.heartbeat", {
      workerId,
      activeRunIds: [...activeRunIds],
      memoryRssMb: process.memoryUsage().rss / 1024 / 1024,
      snapshot,
    })
    .catch(() => {
      // heartbeat failure is non-fatal; supervisor may not be connected yet
    });
}, HEARTBEAT_INTERVAL_MS);

(async () => {
  try {
    const raw = await server.call("worker.ready", { workerId, pid: process.pid });
    const bootstrap = WorkerBootstrap.Bootstrap.parse(raw);
    workerBootstrap = bootstrap;
    // Convert RuntimeAgentDefinition back to AgentProfile.Definition for registry
    const agentDefs = bootstrap.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools.allow ?? [],
      permissions: agent.permissions,
      budget: agent.budget,
    }));
    AgentRegistry.replaceAll(agentDefs);
    console.log(
      `Worker ${workerId} bootstrap received: ${bootstrap.agents.length} agents, ${bootstrap.toolCatalog.length} mcp tools`,
    );
  } catch (err) {
    console.error(
      `Worker ${workerId} bootstrap failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
})();

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

console.log(`Worker ${workerId} started (PID ${process.pid}) socket=${socketPath}`);

export { workerBootstrap };
