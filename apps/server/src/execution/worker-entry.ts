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
  SystemToolProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  createToolExecutor,
  createWorkerSubagentRuntime,
  type NativeTool,
} from "@openomni/openomni";
import { loadConfig } from "../config";
import {
  buildWorkerInputMessages,
  createExecutionToolContext,
  resolveWorkerDbPath,
} from "./worker-runtime";
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
const activeRuns = new Map<
  string,
  { sessionId: string; controller: AbortController; inbox: string[] }
>();
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

function createWorkerInternalTools(runId: string, sessionId: string): NativeTool[] {
  const askMain: NativeTool = {
    spec: {
      name: "ask_main",
      description:
        "Ask the Resident for guidance, approval, or missing context. Blocks until Resident answers.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question or decision request for Resident" },
        },
        required: ["question"],
      },
    },
    source: "server",
    category: "delegation",
    riskTier: 1,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    async execute(call) {
      const question =
        call.input && typeof call.input === "object" && "question" in call.input
          ? String((call.input as { question?: unknown }).question ?? "")
          : "";
      if (!question) {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: "ask_main requires a question",
          isError: true,
        };
      }

      const raw = await server.call("worker.ask_main", {
        authToken: ipcAuthToken,
        workerId,
        sessionId,
        runId,
        question,
      });
      const response =
        raw && typeof raw === "object"
          ? (raw as { accepted?: unknown; output?: unknown; error?: unknown })
          : undefined;
      const accepted = response?.accepted === true;
      const output = accepted
        ? String(response?.output ?? "")
        : String(response?.error ?? "worker.ask_main was rejected");
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output,
        ...(accepted ? {} : { isError: true }),
      };
    },
  };

  const checkInbox: NativeTool = {
    spec: {
      name: "check_inbox",
      description:
        "Fetch live messages delivered by Resident/User while this worker run is active.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    source: "server",
    category: "delegation",
    riskTier: 0,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    async execute(call) {
      const active = activeRuns.get(runId);
      const messages = active?.inbox.splice(0) ?? [];
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: JSON.stringify({ messages, count: messages.length }),
      };
    },
  };

  return [askMain, checkInbox];
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
      const controller = new AbortController();
      activeRuns.set(runId, { sessionId, controller, inbox: [] });
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
        const messages = buildWorkerInputMessages(sessionId, request.prompt);
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
            parentAbort: controller.signal,
          },
          backgroundManager,
        });

        const systemTools = systemProvider.listTools();
        const agentTools = agentProvider.listTools();
        const proxyTools = mcpProxyProvider.listTools();
        const availableTools = [...systemTools, ...agentTools, ...proxyTools];
        const internalTools = createWorkerInternalTools(runId, sessionId);
        const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);
        const internalToolExecutor = createToolExecutor({
          tools: internalTools,
          config: {
            workspaceRoot,
            runtime: {
              sessionId,
              runId,
              agentName: request.agentName,
              workspaceRoot,
            },
          },
        });
        const internalToolNames = new Set(
          internalTools.flatMap((tool) => [tool.spec.name, tool.spec.name.replace(/\./g, "_")]),
        );
        const combinedToolExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
          if (internalToolNames.has(call.tool)) return internalToolExecutor(call);
          if (toolExecutor) return toolExecutor(call);
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Unknown worker tool: ${call.tool}`,
            isError: true,
          };
        };
        const exposedTools = [
          ...(tools ?? []),
          ...internalTools.map((tool) => ({
            ...tool.spec,
            name: tool.spec.name.replace(/\./g, "_"),
          })),
        ];

        toolsRef.tools = exposedTools;
        toolsRef.toolExecutor = combinedToolExecutor;
        catalogRef.catalog = buildToolCatalog([
          { tools: systemTools, source: "system" },
          { tools: agentTools, source: "agent" },
          { tools: proxyTools, source: "mcp" },
        ]);

        const agent = ChatAgent.create({
          model: request.model,
          auth: resolveBootstrapAuth(request.model.provider),
          allowAuthFallback: false,
          signal: controller.signal,
          budget: request.budget,
          systemPrompt: [
            request.systemPrompt,
            "Worker runtime tools: use ask_main when you need Resident guidance or approval; use check_inbox to read live messages delivered while this run is active.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: exposedTools,
          toolExecutor: combinedToolExecutor,
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
          traceContext: { traceId, sessionId, runId },
        });
        if (controller.signal.aborted) {
          server.notify("worker.run_completed", {
            runId,
            sessionId,
            status: "cancelled",
          });
          Bus.publish(Subagent.Events.WorkerSessionCancelled, {
            traceId,
            sessionId,
            runId,
            time: Date.now(),
            payload: { sessionId, runId },
          });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: "cancelled by coordinator",
          });
          return;
        }

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
        const wasCancelled = controller.signal.aborted;
        if (wasCancelled) {
          server.notify("worker.run_completed", {
            runId,
            sessionId,
            status: "cancelled",
            error: errorMessage,
          });
          Bus.publish(Subagent.Events.WorkerSessionCancelled, {
            traceId,
            sessionId,
            runId,
            time: Date.now(),
            payload: { sessionId, runId },
          });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: errorMessage,
          });
          return;
        }
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
        activeRuns.delete(runId);
      }
    })();
  } else if (method === "coordinator.cancel_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ cancelled: false, error: "unauthorized coordinator request" });
      return;
    }
    const runId = typeof params?.runId === "string" ? params.runId : undefined;
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const active = runId ? activeRuns.get(runId) : undefined;
    if (!runId || !active || (sessionId && active.sessionId !== sessionId)) {
      respond({ cancelled: false, error: `run not active: ${runId ?? "unknown"}` });
      return;
    }
    active.controller.abort(new Error("cancelled by coordinator"));
    respond({ cancelled: true, runId, sessionId: active.sessionId });
  } else if (method === "worker.deliver_message") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ accepted: false, error: "unauthorized coordinator request" });
      return;
    }
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const runId = typeof params?.runId === "string" ? params.runId : undefined;
    const message = typeof params?.message === "string" ? params.message : undefined;
    const active = [...activeRuns.entries()].find(
      ([activeRunId, run]) =>
        run.sessionId === sessionId && (runId === undefined || activeRunId === runId),
    );
    if (!sessionId || !message || !active) {
      respond({
        accepted: false,
        error: `run not active for session: ${sessionId ?? "unknown"}`,
      });
      return;
    }
    const [, run] = active;
    run.inbox.push(message);
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "live worker message delivered to active worker inbox",
      context: {
        workerId,
        sessionId,
        runId: active[0],
        bytes: message.length,
        inboxDepth: run.inbox.length,
      },
    });
    respond({
      accepted: true,
    });
  } else if (method === "worker.shutdown_idle") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ acknowledged: false, error: "unauthorized coordinator request" });
      return;
    }
    if (activeRuns.size > 0) {
      respond({ acknowledged: false, error: "worker is busy" });
      return;
    }
    respond({ acknowledged: true });
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 0);
  } else {
    respond({ ok: true });
  }
});

const HEARTBEAT_INTERVAL_MS = 15_000;

setInterval(() => {
  const snapshot: WorkerBootstrap.WorkerSnapshot = {
    activeRuns: [...activeRuns.keys()],
    backgroundTasks: [],
    lastHeartbeat: Date.now(),
    memoryRss: process.memoryUsage().rss / 1024 / 1024,
    configEpoch: workerBootstrap?.configEpoch ?? "",
  };

  server
    .call("worker.heartbeat", {
      workerId,
      authToken: ipcAuthToken,
      activeRunIds: [...activeRuns.keys()],
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
