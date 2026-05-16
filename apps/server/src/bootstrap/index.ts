import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { initialize, Bus, BusPersistence } from "@openomni/session";
import {
  AgentToolProvider,
  IngressEngine,
  SystemToolProvider,
  resolveCategory,
} from "@openomni/openomni";
import { Auth } from "@openomni/llm";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/index";
import { createMessageHandler } from "../handler/conversation";
import { buildToolDispatcher, createExecutionCoordinator } from "../execution/coordinator";
import { createRouter } from "../server/routes";
import { McpToolProvider } from "../tool/mcp";
import { CustomToolProvider } from "../tool/custom";
import { createChannelAdapters } from "./channels";
import { LocalRunner } from "./local-runner";
import { connectMcpServers } from "./mcp";
import { resolveModel } from "./providers";
import { runRecovery } from "./recovery";
import { installShutdownHandlers } from "./shutdown";
import { createAllAgents } from "../agents";

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

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  initialize({ dbPath: config.storage.dbPath });
  BusPersistence.start();

  const systemProvider = new SystemToolProvider(config.workspace?.root);
  const agentProvider = new AgentToolProvider();
  const mcpProvider = new McpToolProvider();
  const customProvider = new CustomToolProvider();

  const projectMcpServers = McpConfigLoader.discover(config.workspace?.root ?? process.cwd());
  const mergedMcpConfig = {
    ...config.mcp,
    servers: McpConfigLoader.merge(config.mcp.servers, projectMcpServers),
  };
  await connectMcpServers({ ...config, mcp: mergedMcpConfig }, mcpProvider);

  const isLocalMode = process.env.OPENOMNI_MODE === "local";

  let coordinator: ReturnType<typeof createExecutionCoordinator> | undefined;

  if (isLocalMode) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server running in local mode (no worker pool)",
    });
    const localRunner = LocalRunner.create({
      systemProvider,
      agentProvider,
      mcpProvider,
      customProvider,
      workspaceRoot: config.workspace?.root,
    });
    IngressEngine.setCoordinator(localRunner);
  } else {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server running in coordinator mode",
    });
    const workerScript = new URL("../execution/worker-entry.ts", import.meta.url).pathname;
    const bootstrap = await assembleBootstrap(mcpProvider);
    const toolDispatcher = buildToolDispatcher([mcpProvider]);
    coordinator = createExecutionCoordinator({ workerScript, bootstrap, toolDispatcher });
    await coordinator.waitUntilReady();
    IngressEngine.setCoordinator(coordinator);
  }

  const hasAnyChannel = Boolean(
    config.telegram.token || config.github.secret || config.discord.token,
  );
  const model = await resolveModel();
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
  const mode = isLocalMode ? "local" : "coordinator";
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
