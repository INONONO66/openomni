import type { CommandModule } from "yargs";
import { Auth, Provider } from "@openomni/llm";
import { Config } from "../config";
import { SurfaceStore } from "../serve/surface-store";
import { TelegramAdapter } from "../adapter/telegram";
import { GitHubAdapter } from "../adapter/github";
import { DiscordAdapter } from "../adapter/discord";
import {
  createMessageHandler,
  type ConversationConfig,
} from "../serve/conversation";
import type { Adapter } from "../adapter/types";

type ServeArgs = {
  port: number;
  host: string;
  "telegram-token"?: string;
  "github-secret"?: string;
  "github-token"?: string;
  "discord-token"?: string;
  provider?: string;
  model?: string;
  system?: string;
};

async function resolveModel(
  requestedProviderID?: string,
  requestedModelID?: string,
): Promise<Provider.Model> {
  const credentials = await Auth.all();
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    console.error("No credentials found. Run 'openomni auth login' first.");
    process.exit(1);
  }

  const providerID = requestedProviderID ?? entries[0][0];
  const auth = credentials[providerID];

  if (!auth) {
    console.error(`No credentials found for '${providerID}'.`);
    process.exit(1);
  }

  const models = await Provider.listModels(providerID, auth.type);

  if (models.length === 0) {
    console.error(`No models found for provider '${providerID}'.`);
    process.exit(1);
  }

  if (requestedModelID) {
    const model = models.find((m) => m.id === requestedModelID);
    if (!model) {
      console.error(
        `Model '${requestedModelID}' not found for '${providerID}'.`,
      );
      process.exit(1);
    }
    return model;
  }

  return models[0];
}

export const ServeCommand: CommandModule<object, ServeArgs> = {
  command: "serve",
  describe: "Start the OpenOmni server",
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number",
        default: 3000,
        describe: "HTTP server port",
      })
      .option("host", {
        type: "string",
        default: "127.0.0.1",
        describe: "HTTP server bind address",
      })
      .option("telegram-token", {
        type: "string",
        describe: "Telegram bot token",
      })
      .option("github-secret", {
        type: "string",
        describe: "GitHub webhook secret",
      })
      .option("github-token", {
        type: "string",
        describe: "GitHub API token for posting comments",
      })
      .option("discord-token", {
        type: "string",
        describe: "Discord bot token",
      })
      .option("provider", {
        alias: "p",
        type: "string",
        describe: "LLM provider ID",
      })
      .option("model", {
        alias: "m",
        type: "string",
        describe: "Model ID",
      })
      .option("system", {
        alias: "s",
        type: "string",
        describe: "System prompt",
      }),
  handler: async (argv) => {
    // Secure sensitive files on boot
    Config.secureAll();

    // Restore surface key mappings from disk
    SurfaceStore.initialize();

    const model = await resolveModel(argv.provider, argv.model);
    console.log(`Using model: ${model.providerID}/${model.id}`);

    const conversationConfig: ConversationConfig = {
      model,
      system: argv.system,
    };

    // Shared message handler for all adapters
    const handler = createMessageHandler(conversationConfig);

    // -- Resolve adapter credentials: CLI args > env > config file --------

    const adapterConfig = Config.load();

    const telegramToken =
      argv["telegram-token"] ??
      process.env.OPENOMNI_TELEGRAM_TOKEN ??
      adapterConfig.telegram?.token;

    const githubSecret =
      argv["github-secret"] ??
      process.env.OPENOMNI_GITHUB_SECRET ??
      adapterConfig.github?.secret;

    const githubToken =
      argv["github-token"] ??
      process.env.OPENOMNI_GITHUB_TOKEN ??
      adapterConfig.github?.token;

    const discordToken =
      argv["discord-token"] ??
      process.env.OPENOMNI_DISCORD_TOKEN ??
      adapterConfig.discord?.token;

    // -- Start adapters ---------------------------------------------------

    const adapters: Adapter.Surface[] = [];

    if (telegramToken) {
      const telegramAllowed = adapterConfig.telegram?.allowedUsers;
      const telegram = new TelegramAdapter(telegramToken, {
        triggers: [
          ...(telegramAllowed
            ? [{ type: "sender" as const, allow: telegramAllowed }]
            : []),
        ],
        // TODO: DeliveryPolicy is not yet enforced — currently a placeholder type only
        deliveryPolicy: "final",
      });
      telegram.onMessage(handler);
      await telegram.start();
      adapters.push(telegram);
    }

    let github: GitHubAdapter | undefined;
    if (githubSecret) {
      const githubAllowed = adapterConfig.github?.allowedUsers;
      github = new GitHubAdapter(
        githubSecret,
        {
          triggers: [
            {
              type: "event",
              events: ["issue_comment.created", "issues.opened"],
            },
            ...(githubAllowed
              ? [{ type: "sender" as const, allow: githubAllowed }]
              : []),
          ],
          // TODO: DeliveryPolicy is not yet enforced — currently a placeholder type only
          deliveryPolicy: "final",
        },
        githubToken,
        adapterConfig.github?.botUsername,
      );
      github.onMessage(handler);
      await github.start();
      adapters.push(github);
    }

    if (discordToken) {
      const discordAllowed = adapterConfig.discord?.allowedUsers;
      const discord = new DiscordAdapter(discordToken, {
        triggers: [
          { type: "mention" },
          ...(discordAllowed
            ? [{ type: "sender" as const, allow: discordAllowed }]
            : []),
        ],
        // TODO: DeliveryPolicy is not yet enforced — currently a placeholder type only
        deliveryPolicy: "final",
      });
      discord.onMessage(handler);
      await discord.start();
      adapters.push(discord);
    }

    if (adapters.length === 0) {
      console.log(
        "No adapters configured. Run 'openomni config add' or pass tokens via CLI args.",
      );
      console.log("Server will start but won't process any messages.");
    }

    // -- HTTP server ------------------------------------------------------

    const server = Bun.serve({
      port: argv.port,
      hostname: argv.host,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          return new Response("OK");
        }

        if (
          url.pathname === "/github/webhook" &&
          github &&
          request.method === "POST"
        ) {
          return github.handleWebhook(request);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    console.log(`Server listening on http://${argv.host}:${server.port}`);

    // -- Graceful shutdown ------------------------------------------------

    const shutdown = () => {
      console.log("\nShutting down...");
      for (const adapter of adapters) {
        adapter.stop();
      }
      server.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
};
