import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Auth, Provider } from "@openomni/llm";
import { Storage, initialize } from "@openomni/session";
import type { Adapter } from "@openomni/protocol";
import { loadConfig, getConfig } from "./config";
import { createRouter } from "./routes";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter } from "./channel";
import { createMessageHandler, type ConversationConfig } from "./handler/conversation";
import { recoverInterruptedMessages, type RecoveryItem } from "./recovery";

async function resolveModel(): Promise<Provider.Model> {
  const { provider: requestedProviderID, model: requestedModelID } = getConfig().model;
  const credentials = await Auth.all();
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    throw new Error("No credentials found. Run 'openomni auth login' first.");
  }

  const providerID = requestedProviderID ?? entries[0][0];
  const auth = credentials[providerID];

  if (!auth) {
    throw new Error(`No credentials found for '${providerID}'.`);
  }

  const authType = auth.type === "oauth" ? "api" : auth.type;
  const models = await Provider.listModels(providerID, authType);

  if (models.length === 0) {
    throw new Error(`No models found for provider '${providerID}'.`);
  }

  if (requestedModelID) {
    const model = models.find((m) => m.id === requestedModelID);
    if (!model) {
      throw new Error(`Model '${requestedModelID}' not found for '${providerID}'.`);
    }
    return model;
  }

  return models[0];
}

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Adapter.MessageHandler,
): Promise<void> {
  console.log(`[recovery] Processing ${queue.length} retry item(s)...`);
  for (const item of queue) {
    try {
      await handler({
        id: `recovery-${item.messageId}`,
        surfaceKey: item.surfaceKey,
        text: item.text,
        sender: { id: "recovery", name: "Recovery" },
      });
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

  const sqliteAdapter = Storage.get() as unknown as {
    transaction(fn: () => void): void;
    close(): void;
    sqlite: { exec(sql: string): void };
  };

  const hasAnyChannel = Boolean(
    config.telegram.token || config.github.secret || config.discord.token,
  );

  let conversationConfig: ConversationConfig | undefined;
  if (hasAnyChannel) {
    const model = await resolveModel();
    conversationConfig = { model, system: config.model.system };
    console.log(`[server] Using model: ${model.providerID}/${model.id}`);
  }

  const handler = conversationConfig ? createMessageHandler(conversationConfig) : undefined;
  const channels: Adapter.Surface[] = [];

  if (config.telegram.token && handler) {
    const telegram = new TelegramAdapter(config.telegram.token, {
      triggers: [
        ...(config.telegram.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.telegram.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    telegram.onMessage(handler);
    channels.push(telegram);
  }

  let githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;
  if (config.github.secret && handler) {
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
    github.onMessage(handler);
    githubWebhookHandler = (req) => github.handleWebhook(req);
    channels.push(github);
  }

  if (config.discord.token && handler) {
    const discord = new DiscordAdapter(config.discord.token, {
      triggers: [
        { type: "mention" },
        ...(config.discord.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.discord.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    discord.onMessage(handler);
    channels.push(discord);
  }

  if (hasAnyChannel && !handler) {
    console.warn("[server] channel credentials found but no model credentials; channels disabled");
  }

  if (channels.length === 0) {
    console.log("[server] No channels configured. Starting HTTP-only mode.");
  }

  const app = createRouter(githubWebhookHandler);
  await Promise.all(channels.map((channel) => channel.start()));

  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    fetch: app.fetch,
  });

  console.log(`[server] listening on http://${config.server.host}:${server.port}`);

  const retryQueue = await recoverInterruptedMessages();
  if (handler && retryQueue.length > 0) {
    await processRetryQueue(retryQueue, handler);
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
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    sqliteAdapter.transaction(() => {
      (sqliteAdapter as unknown as { sqlite: { exec(sql: string): void } }).sqlite.exec(
        "PRAGMA wal_checkpoint(TRUNCATE)",
      );
    });
    sqliteAdapter.close();

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
