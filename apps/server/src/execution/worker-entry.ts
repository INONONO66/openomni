import { ChatAgent, AgentRegistry } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import { createIpcServer } from "@openomni/coordinator";
import { Execution, Subagent, Tool, WorkerBootstrap } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { initialize, Bus, BusPersistence } from "@openomni/session";
import {
  AgentToolProvider,
  BackgroundManager,
  ToolProxyProvider,
  SessionBridge,
  SystemToolProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  createWorkerSubagentRuntime,
} from "@openomni/openomni";
import { loadConfig } from "../config";
import { createExecutionToolContext, resolveWorkerDbPath } from "./worker-runtime";
import { createContextMiddleware } from "../context/index";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id") ?? "unknown";
const socketPath = readCliArg("--socket");
const ipcAuthToken = process.env.OPENOMNI_WORKER_IPC_TOKEN;
delete process.env.OPENOMNI_WORKER_IPC_TOKEN;

if (!socketPath) {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "worker-entry: missing --socket argument",
  });
  process.exit(1);
}

if (!ipcAuthToken) {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "worker-entry: missing IPC auth token",
  });
  process.exit(1);
}

const config = loadConfig();
initialize({
  dbPath: resolveWorkerDbPath(config),
});
BusPersistence.start();

let workerBootstrap: WorkerBootstrap.Bootstrap | null = null;
const activeRunIds = new Set<string>();
let resolveBootstrapReady: () => void = () => undefined;
let rejectBootstrapReady: (_error: Error) => void = () => undefined;
const bootstrapReady = new Promise<void>((resolve, reject) => {
  resolveBootstrapReady = resolve;
  rejectBootstrapReady = reject;
});

const backgroundManager = BackgroundManager.create({
  maxConcurrentPerAgent: 3,
  maxConcurrentTotal: 10,
  maxDepth: 3,
  resolveAuth: resolveBootstrapAuth,
  allowAuthFallback: false,
});

function resolveBootstrapAuth(provider: string): Auth.Info | undefined {
  const credentials = workerBootstrap?.credentials;
  if (!credentials) return undefined;

  const prefix = provider.toUpperCase();
  const apiKey = credentials[`${prefix}_API_KEY`];
  const baseURL = credentials[`${prefix}_BASE_URL`];

  if (baseURL) {
    return { type: "proxy", baseURL, ...(apiKey ? { apiKey } : {}) };
  }
  if (apiKey) {
    return { type: "api", key: apiKey };
  }
  return undefined;
}

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }

    try {
      const bootstrap = WorkerBootstrap.Bootstrap.parse(params.bootstrap);
      workerBootstrap = bootstrap;
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
      server.useConnection(connectionId);
      resolveBootstrapReady();
      server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
      Bus.publish(Operational.Info, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap received",
        context: {
          workerId,
          agents: bootstrap.agents.length,
          mcpTools: bootstrap.toolCatalog.length,
        },
      });
      respond({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectBootstrapReady(error);
      respond({ ok: false, error: error.message });
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap failed",
        context: {
          workerId,
          err: error.message,
        },
      });
    }
  } else if (method === "coordinator.spawn_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
        error: "unauthorized coordinator request",
      });
      return;
    }

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
      const traceId = request.traceId ?? crypto.randomUUID();
      activeRunIds.add(runId);
      server.notify("worker.run_started", { runId, sessionId });
      Bus.publish(Subagent.Events.WorkerRunStarted, {
        traceId,
        sessionId,
        runId,
        time: Date.now(),
        payload: { sessionId, runId, title: request.prompt.slice(0, 80) },
      });

      try {
        await bootstrapReady;
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

        const toolsRef: Parameters<typeof createWorkerSubagentRuntime>[0]["toolsRef"] = {};
        const catalogRef: { catalog?: ReturnType<typeof buildToolCatalog> } = {};
        const agentDefinitionsRef: {
          definitions?: Map<string, WorkerBootstrap.RuntimeAgentDefinition>;
        } = {
          definitions: new Map((workerBootstrap?.agents ?? []).map((agent) => [agent.name, agent])),
        };

        const agentProvider = new AgentToolProvider({
          subagentRuntime: createWorkerSubagentRuntime({
            toolsRef,
            catalogRef,
            agentDefinitionsRef,
            resolveAuth: resolveBootstrapAuth,
            allowAuthFallback: false,
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

        const systemTools = systemProvider.listTools();
        const agentTools = agentProvider.listTools();
        const proxyTools = mcpProxyProvider.listTools();
        const availableTools = [...systemTools, ...agentTools, ...proxyTools];
        const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);

        toolsRef.tools = tools;
        toolsRef.toolExecutor = toolExecutor;
        catalogRef.catalog = buildToolCatalog([
          { tools: systemTools, source: "system" },
          { tools: agentTools, source: "agent" },
          { tools: proxyTools, source: "mcp" },
        ]);

        const agent = ChatAgent.create({
          model: request.model,
          auth: resolveBootstrapAuth(request.model.provider),
          allowAuthFallback: false,
          systemPrompt: request.systemPrompt,
          budget: request.budget,
          tools,
          toolExecutor,
          middleware: [
            createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
            ...buildWorkerMiddleware({
              permissions: request.permissions,
              ...(request.policyPlan ? { policyPlan: request.policyPlan } : {}),
            }),
          ],
        });
        const runResult = await agent.run({
          messages,
          traceContext: { traceId: request.traceId ?? crypto.randomUUID(), sessionId, runId },
        });

        server.notify("worker.run_completed", {
          runId,
          sessionId,
          status: "succeeded",
          output: runResult.text,
        });
        Bus.publish(Subagent.Events.WorkerRunCompleted, {
          traceId,
          sessionId,
          runId,
          time: Date.now(),
          payload: { sessionId, runId, status: "succeeded" },
        });

        respond({
          runId,
          sessionId,
          status: "succeeded",
          output: runResult.text,
          finishReason: runResult.finishReason,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        server.notify("worker.run_completed", {
          runId,
          sessionId,
          status: "failed",
          error: errorMessage,
        });
        Bus.publish(Subagent.Events.WorkerRunFailed, {
          traceId,
          sessionId,
          runId,
          time: Date.now(),
          payload: { sessionId, runId, error: errorMessage },
        });

        respond({
          runId,
          sessionId,
          status: "failed",
          error: errorMessage,
        });
      } finally {
        activeRunIds.delete(runId);
      }
    })();
  } else if (method === "coordinator.cancel_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ cancelled: false, error: "unauthorized coordinator request" });
      return;
    }
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
      authToken: ipcAuthToken,
      activeRunIds: [...activeRunIds],
      memoryRssMb: process.memoryUsage().rss / 1024 / 1024,
      snapshot,
    })
    .catch(() => {
      // heartbeat failure is non-fatal; supervisor may not be connected yet
    });
}, HEARTBEAT_INTERVAL_MS);

process.on("SIGTERM", async () => {
  await BusPersistence.flush();
  BusPersistence.stop();
  server.close();
  process.exit(0);
});

Bus.publish(Operational.Info, {
  traceId: crypto.randomUUID(),
  time: Date.now(),
  component: "server",
  msg: "worker started",
  context: { workerId, pid: process.pid, socketPath },
});

export { workerBootstrap };
