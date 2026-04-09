import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Auth, Provider } from "@openomni/llm";
import type { Adapter } from "@openomni/protocol";
import { Storage, initialize } from "@openomni/session";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter, WebSocketHandler } from "./channel";
import { loadConfig } from "./config";
import { createMessageHandler } from "./handler/conversation";
import { detectMode } from "./ingress/mode";
import { recoverInterruptedMessages, type RecoveryItem } from "./recovery";
import { createRouter } from "./routes";
import { AgentToolProvider } from "./tool/agent";
import { McpToolProvider } from "./tool/mcp";
import { SystemToolProvider } from "./tool/system";
import type { ServerConfig } from "./config";

type Surface = {
  start(): Promise<void> | void;
  stop(): void;
};

interface ClosableStorage {
  transaction(fn: () => void): void;
  close(): void;
  sqlite: { exec(sql: string): void };
}

function isClosableStorage(storage: unknown): storage is ClosableStorage {
  const s = storage as Record<string, unknown>;
  return typeof s.close === "function" && typeof s.transaction === "function" && s.sqlite != null;
}

async function resolveModel(): Promise<Provider.Model | undefined> {
  try {
    const credentials = await Auth.all();
    const entries = Object.entries(credentials);
    if (entries.length === 0) return undefined;

    const providerID = entries[0][0];
    const auth = credentials[providerID];
    if (!auth) return undefined;

    const authType = auth.type === "oauth" ? "api" : auth.type;
    const models = await Provider.listModels(providerID, authType);
    return models[0];
  } catch (err) {
    console.warn("[server] failed to resolve model:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

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

async function connectMcpServers(config: ServerConfig, provider: McpToolProvider): Promise<void> {
  const servers = config.mcp.servers;
  if (servers.length === 0) return;

  for (const server of servers) {
    await provider.addServer(server);
  }

  await provider.refreshTools();
  console.log(`[mcp] connected ${provider.serverCount}/${servers.length} server(s)`);
}

function stripPlanTeamPrefix(raw: string): string {
  return detectMode(raw).text;
}

function toRecoveryInboundMessage(item: RecoveryItem): Adapter.InboundMessage {
  return {
    id: item.messageId,
    surfaceKey: item.surfaceKey,
    text: stripPlanTeamPrefix(item.text),
    sender: { id: "recovery", name: "recovery" },
  };
}

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Adapter.MessageHandler,
): Promise<void> {
  console.log(`[recovery] Processing ${queue.length} retry item(s)...`);

  for (const item of queue) {
    try {
      await handler(toRecoveryInboundMessage(item));
    } catch (err) {
      console.error(`[recovery] Retry failed for ${item.messageId}:`, err);
    }
  }

  console.log("[recovery] Retry processing complete");
}

async function main(): Promise<void> {
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
        {
          provider: model.providerID,
          id: model.id,
        },
      )
    : undefined;
  const wsHandler = routingHandler
    ? new WebSocketHandler(routingHandler, { token: config.server.wsToken })
    : undefined;
  if (model) {
    console.log(`[server] Using model: ${model.providerID}/${model.id}`);
  } else {
    console.warn("[server] no model credentials found; realtime surfaces disabled");
  }

  const channels: Surface[] = [];
  let githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;

  if (config.telegram.token && routingHandler) {
    const telegram = new TelegramAdapter(config.telegram.token, {
      triggers: [
        ...(config.telegram.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.telegram.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    telegram.onMessage(routingHandler);
    channels.push(telegram);
  }

  if (config.github.secret && routingHandler) {
    const github = new GitHubAdapter(
      config.github.secret,
      {
        triggers: [
          { type: "event", events: ["issue_comment.created", "issues.opened"] },
          ...(config.github.allowedUsers.length > 0
            ? [{ type: "sender" as const, allow: config.github.allowedUsers }]
            : []),
        ],
        deliveryPolicy: "final",
      },
      config.github.token,
      config.github.botUsername,
    );
    github.onMessage(routingHandler);
    githubWebhookHandler = (req) => github.handleWebhook(req);
    channels.push(github);
  }

  if (config.discord.token && routingHandler) {
    const discord = new DiscordAdapter(config.discord.token, {
      triggers: [
        { type: "mention" },
        ...(config.discord.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.discord.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    discord.onMessage(routingHandler);
    channels.push(discord);
  }

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

  const retryQueue = await recoverInterruptedMessages();
  if (routingHandler && retryQueue.length > 0) {
    await processRetryQueue(retryQueue, routingHandler);
  } else if (retryQueue.length > 0) {
    console.warn(`[recovery] ${retryQueue.length} message(s) need retry but no handler available`);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("[server] shutting down...");

    for (const channel of channels) {
      channel.stop();
    }

    server.stop(true);
    await mcpProvider.disconnectAll();
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const storage = Storage.get();
    if (isClosableStorage(storage)) {
      storage.transaction(() => {
        storage.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      });
      storage.close();
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error("[server] fatal error:", error);
  process.exit(1);
});
