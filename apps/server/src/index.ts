import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Auth, Provider } from "@openomni/llm";
import { Storage, initialize } from "@openomni/session";
import type { Adapter } from "@openomni/protocol";
import { createRouter } from "./routes";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter } from "./channel";
import { createMessageHandler, type ConversationConfig } from "./handler/conversation";
import { recoverInterruptedMessages, type RecoveryItem } from "./recovery";

interface AdapterConfig {
  telegram?: {
    token?: string;
    allowedUsers?: string[];
  };
  github?: {
    secret?: string;
    token?: string;
    botUsername?: string;
    allowedUsers?: string[];
  };
  discord?: {
    token?: string;
    allowedUsers?: string[];
  };
}

const CONFIG_PATH = join(homedir(), ".openomni", "config.json");

function loadAdapterConfig(): AdapterConfig {
  if (!existsSync(CONFIG_PATH)) return {};

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AdapterConfig;
    return parsed ?? {};
  } catch (error) {
    console.warn(
      "[server] failed to read config.json:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

async function resolveModel(
  requestedProviderID?: string,
  requestedModelID?: string,
): Promise<Provider.Model> {
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
  const dbPath = process.env.OPENOMNI_DB_PATH ?? join(homedir(), ".openomni", "storage.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  initialize({ dbPath });

  const sqliteAdapter = Storage.get() as unknown as {
    transaction(fn: () => void): void;
    close(): void;
    sqlite: { exec(sql: string): void };
  };

  const adapterConfig = loadAdapterConfig();

  const telegramToken = process.env.OPENOMNI_TELEGRAM_TOKEN ?? adapterConfig.telegram?.token;
  const githubSecret = process.env.OPENOMNI_GITHUB_SECRET ?? adapterConfig.github?.secret;
  const githubToken = process.env.OPENOMNI_GITHUB_TOKEN ?? adapterConfig.github?.token;
  const discordToken = process.env.OPENOMNI_DISCORD_TOKEN ?? adapterConfig.discord?.token;

  const hasAnyChannelCredential = Boolean(telegramToken || githubSecret || discordToken);

  let conversationConfig: ConversationConfig | undefined;
  if (hasAnyChannelCredential) {
    const model = await resolveModel(process.env.OPENOMNI_PROVIDER, process.env.OPENOMNI_MODEL);
    conversationConfig = {
      model,
      system: process.env.OPENOMNI_SYSTEM,
    };
    console.log(`[server] Using model: ${model.providerID}/${model.id}`);
  }

  const handler = conversationConfig ? createMessageHandler(conversationConfig) : undefined;
  const channels: Adapter.Surface[] = [];

  if (telegramToken && handler) {
    const telegram = new TelegramAdapter(telegramToken, {
      triggers: [
        ...(adapterConfig.telegram?.allowedUsers
          ? [{ type: "sender" as const, allow: adapterConfig.telegram.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    telegram.onMessage(handler);
    channels.push(telegram);
  }

  let githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;
  if (githubSecret && handler) {
    const github = new GitHubAdapter(
      githubSecret,
      {
        triggers: [
          { type: "event", events: ["issue_comment.created", "issues.opened"] },
          ...(adapterConfig.github?.allowedUsers
            ? [{ type: "sender" as const, allow: adapterConfig.github.allowedUsers }]
            : []),
        ],
        deliveryPolicy: "final",
      },
      githubToken,
      adapterConfig.github?.botUsername,
    );
    github.onMessage(handler);
    githubWebhookHandler = (req) => github.handleWebhook(req);
    channels.push(github);
  }

  if (discordToken && handler) {
    const discord = new DiscordAdapter(discordToken, {
      triggers: [
        { type: "mention" },
        ...(adapterConfig.discord?.allowedUsers
          ? [{ type: "sender" as const, allow: adapterConfig.discord.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    discord.onMessage(handler);
    channels.push(discord);
  }

  if (hasAnyChannelCredential && !handler) {
    console.warn("[server] channel credentials found but no model credentials; channels disabled");
  }

  if (channels.length === 0) {
    console.log("[server] No channels configured. Starting HTTP-only mode.");
  }

  const app = createRouter(githubWebhookHandler);

  await Promise.all(channels.map((channel) => channel.start()));

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  console.log(`[server] listening on http://${host}:${server.port}`);

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
