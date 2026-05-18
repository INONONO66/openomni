import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { initialize, Bus, BusPersistence, WorkerRun } from "@openomni/session";
import {
  AgentToolProvider,
  IngressEngine,
  ResidentRuntime,
  createResidentWorkerTools,
  SystemToolProvider,
  resolveCategory,
} from "@openomni/openomni";
import { Auth } from "@openomni/llm";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/index";
import { createMessageHandler } from "../handler/conversation";
import { buildAgentDef, buildResidentAgentDef } from "../ingress/bridge";
import { buildToolDispatcher, createExecutionCoordinator } from "../execution/coordinator";
import { createRouter } from "../server/routes";
import { McpToolProvider } from "../tool/mcp";
import { CustomToolProvider } from "../tool/custom";
import { createChannelAdapters } from "./channels";
import { connectMcpServers } from "./mcp";
import { resolveModel } from "./providers";
import { runRecovery } from "./recovery";
import { installShutdownHandlers } from "./shutdown";
import { createAllAgents, registerAgent } from "../agents";
import { createResidentProfile } from "../profile/resident";

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

async function assembleBootstrap(mcpProvider: McpToolProvider): Promise<WorkerBootstrap.Bootstrap> {
  const agents = [...createAllAgents().values()].map(
    (def): WorkerBootstrap.RuntimeAgentDefinition => ({
      name: def.name,
      description: def.description,
      model: def.model,
      systemPrompt: def.systemPrompt,
      tools: def.tools,
      permissions: def.permissions,
      budget: def.budget,
    }),
  );

  const toolCatalog = mcpProvider.listTools().map(
    (tool): WorkerBootstrap.RuntimeToolCatalogEntry => ({
      canonicalName: tool.spec.name,
      exposedName: tool.spec.name,
      source: "mcp",
      category: resolveCategory(tool.spec.name, "mcp", tool.category),
      riskTier: tool.riskTier,
      spec: tool.spec,
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
      mcpServer: tool.spec.name.includes(".") ? tool.spec.name.split(".")[0] : undefined,
    }),
  );

  const authEntries = await Auth.all();
  const credentials: Record<string, string> = {};
  for (const [provider, entry] of Object.entries(authEntries)) {
    const prefix = provider.toUpperCase();
    if (entry.type === "api") {
      credentials[`${prefix}_API_KEY`] = entry.key;
    } else if (entry.type === "proxy") {
      credentials[`${prefix}_BASE_URL`] = entry.baseURL;
      if (entry.apiKey) credentials[`${prefix}_API_KEY`] = entry.apiKey;
    }
  }

  const epochInput = [
    ...agents.map((a) => a.name).sort(),
    ...toolCatalog.map((t) => t.canonicalName).sort(),
  ].join(",");
  const configEpoch = djb2Hash(epochInput);

  return { configEpoch, agents, toolCatalog, credentials };
}

function createRoutingHandler(
  systemProvider: SystemToolProvider,
  agentProvider: AgentToolProvider,
  mcpProvider: McpToolProvider,
  workspaceRoot: string,
  defaultModel?: { provider: string; id: string },
  customProvider?: CustomToolProvider,
): Adapter.MessageHandler {
  return createMessageHandler({
    systemProvider,
    agentProvider,
    mcpProvider,
    customProvider,
    defaultModel,
    workspaceRoot,
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.OPENOMNI_MODE === "local") {
    throw new Error("OPENOMNI_MODE=local is disabled; OpenOmni requires coordinator mode");
  }

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  initialize({ dbPath: config.storage.dbPath });
  BusPersistence.start();

  const systemProvider = new SystemToolProvider(config.workspace?.root);
  const agentProvider = new AgentToolProvider();
  const mcpProvider = new McpToolProvider();

  const projectMcpServers = McpConfigLoader.discover(config.workspace?.root ?? process.cwd());
  const mergedMcpConfig = {
    ...config.mcp,
    servers: McpConfigLoader.merge(config.mcp.servers, projectMcpServers),
  };
  await connectMcpServers({ ...config, mcp: mergedMcpConfig }, mcpProvider);

  const residentRuntime = ResidentRuntime.create({
    maxActive: 10,
    idleTimeoutMs: Number(process.env.OPENOMNI_RESIDENT_IDLE_TIMEOUT_MS ?? 30_000),
  });
  IngressEngine.setResidentRuntime(residentRuntime);

  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "server running in coordinator mode",
  });
  const workerScript = new URL("../execution/worker-entry.ts", import.meta.url).pathname;
  const bootstrap = await assembleBootstrap(mcpProvider);
  const hasAnyChannel = Boolean(
    config.telegram.token || config.github.secret || config.discord.token,
  );
  const model = await resolveModel();
  const residentProfile = model
    ? await createResidentProfile({ model: { provider: model.providerID, id: model.id } })
    : undefined;
  if (residentProfile) registerAgent(residentProfile.factory, residentProfile.metadata);
  const residentWorkerTools = model
    ? createResidentWorkerTools({
        ingest: IngressEngine.ingest,
        surface: "resident-worker-tool",
        residentAgentNames: ["resident"],
        resolveWorkerAgent: ({ agentName, workspaceRoot }) =>
          buildAgentDef(agentName, {
            systemProvider,
            agentProvider,
            mcpProvider,
            defaultModel: { provider: model.providerID, id: model.id },
            workspaceRoot: workspaceRoot ?? config.workspace?.root ?? process.cwd(),
          }),
      })
    : [];
  const customProvider = new CustomToolProvider(residentWorkerTools);
  const toolDispatcher = buildToolDispatcher([mcpProvider]);
  const coordinator = createExecutionCoordinator({
    workerScript,
    bootstrap,
    toolDispatcher,
    askResident: async ({ workerId, sessionId, runId, question, signal }) => {
      const requestId = crypto.randomUUID();
      if (signal?.aborted) {
        return { requestId, accepted: false, error: "worker.ask_main aborted" };
      }
      if (!model) {
        return { requestId, accepted: false, error: "worker.ask_main requires a configured model" };
      }
      const run = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      const mainSessionId = run?.parentSessionId;
      if (!mainSessionId) {
        return {
          requestId,
          accepted: false,
          error: `worker.ask_main requires a worker run with parent Resident session: ${runId ?? "unknown"}`,
        };
      }

      const current = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      if (runId && current && current.status === "starting") {
        await WorkerRun.updateStatus(sessionId, runId, "running");
      }
      const running = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      if (runId && running?.status === "running") {
        await WorkerRun.updateStatus(sessionId, runId, "waiting_input");
      }

      try {
        const result = await IngressEngine.ingest({
          id: crypto.randomUUID(),
          surface: "worker-ask-resident",
          workspace: config.workspace?.root ?? process.cwd(),
          mode: "direct",
          payload: `Worker ${workerId}${runId ? ` run ${runId}` : ""} asks Resident:\n\n${question}`,
          runtime: {
            durableSessionId: mainSessionId,
            lifecycle: "active",
            ...(signal ? { signal } : {}),
          },
          target: { kind: "resident" },
          meta: {
            actor: {
              role: "worker",
              trusted: true,
              workerId,
              sessionId,
              runId,
            },
            target: { kind: "resident" },
            agentName: "resident",
          },
          agent: buildResidentAgentDef("resident", {
            systemProvider,
            agentProvider,
            mcpProvider,
            customProvider,
            defaultModel: { provider: model.providerID, id: model.id },
            workspaceRoot: config.workspace?.root ?? process.cwd(),
          }),
        });
        return { requestId, accepted: true, output: result.result.output };
      } finally {
        const after = runId ? await WorkerRun.get(sessionId, runId) : undefined;
        if (runId && after?.status === "waiting_input") {
          await WorkerRun.updateStatus(sessionId, runId, "running");
        }
      }
    },
    maxWorkers: 10,
    workerIdleTimeoutMs: Number(process.env.OPENOMNI_WORKER_IDLE_TIMEOUT_MS ?? 30_000),
  });
  IngressEngine.setCoordinator(coordinator);

  const routingHandler = model
    ? createRoutingHandler(
        systemProvider,
        agentProvider,
        mcpProvider,
        config.workspace?.root ?? process.cwd(),
        { provider: model.providerID, id: model.id },
        customProvider,
      )
    : undefined;

  if (model) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: `server using model: ${model.providerID}/${model.id}`,
    });
  } else {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server no model credentials found; realtime surfaces disabled",
    });
  }

  const { channels, wsHandler, githubWebhookHandler } = createChannelAdapters(
    config,
    routingHandler,
  );

  if (hasAnyChannel && !routingHandler) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server channel credentials found but no model credentials; channels disabled",
    });
  }

  const app = createRouter(githubWebhookHandler);
  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: Bun.serve requires a websocket object; these are intentional no-ops when WS is disabled
    websocket: wsHandler?.ws ?? { open() {}, message() {} },
    fetch(req, serverInstance) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
        if (!wsHandler) {
          return new Response("WebSocket unavailable", { status: 503 });
        }
        const response = wsHandler.handleUpgrade(req, serverInstance);
        return response ?? new Response(null, { status: 101 });
      }
      return app.fetch(req, serverInstance);
    },
  });

  await Promise.all(channels.map((channel) => channel.start()));

  if (channels.length === 0) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server no external channels configured; web and websocket endpoints only",
    });
  }

  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: `server listening on http://${config.server.host}:${server.port}`,
  });
  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: `server websocket endpoint ready at ws://${config.server.host}:${server.port}/ws`,
  });

  const traceId = crypto.randomUUID();
  const mode = "coordinator";
  await runRecovery(routingHandler, coordinator, traceId);

  Bus.publish(Operational.BootstrapCompleted, {
    traceId,
    mode,
    channelCount: channels.length,
    time: Date.now(),
  });

  installShutdownHandlers({
    channels,
    server,
    mcpProvider,
    coordinator,
    traceId,
  });
}
