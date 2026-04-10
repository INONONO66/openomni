import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@openomni/protocol";
import { initialize } from "@openomni/session";
import { loadConfig } from "../config";
import { createMessageHandler } from "../handler/conversation";
import { createRouter } from "../server/routes";
import { AgentToolProvider } from "../tool/agent";
import { McpToolProvider } from "../tool/mcp";
import { SystemToolProvider } from "../tool/system";
import { createChannelAdapters } from "./channels";
import { connectMcpServers } from "./mcp";
import { resolveModel } from "./providers";
import { runRecovery } from "./recovery";
import { installShutdownHandlers } from "./shutdown";

function createRoutingHandler(
  systemProvider: SystemToolProvider,
  agentProvider: AgentToolProvider,
  mcpProvider: McpToolProvider,
  workspaceRoot: string,
  defaultModel?: { provider: string; id: string },
): Adapter.MessageHandler {
  return createMessageHandler({
    systemProvider,
    agentProvider,
    mcpProvider,
    defaultModel,
    workspaceRoot,
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  initialize({ dbPath: config.storage.dbPath });

  const systemProvider = new SystemToolProvider(config.workspace?.root);
  const agentProvider = new AgentToolProvider();
  const mcpProvider = new McpToolProvider();

  await connectMcpServers(config, mcpProvider);

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
      )
    : undefined;

  if (model) {
    console.log(`[server] Using model: ${model.providerID}/${model.id}`);
  } else {
    console.warn("[server] no model credentials found; realtime surfaces disabled");
  }

  const { channels, wsHandler, githubWebhookHandler } = createChannelAdapters(
    config,
    routingHandler,
  );

  if (hasAnyChannel && !routingHandler) {
    console.warn("[server] channel credentials found but no model credentials; channels disabled");
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
    console.log("[server] No external channels configured. Web and WebSocket endpoints only.");
  }

  console.log(`[server] listening on http://${config.server.host}:${server.port}`);
  console.log(`[server] websocket endpoint ready at ws://${config.server.host}:${server.port}/ws`);

  await runRecovery(routingHandler);

  installShutdownHandlers({ channels, server, mcpProvider });
}
