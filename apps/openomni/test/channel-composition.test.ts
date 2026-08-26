import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { createChannelDrivers } from "../src/channels";
import { loadConfig, type OpenOmniConfig } from "../src/config";

const CHANNEL_ENV_KEYS = [
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_BOT_USERNAME",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(CHANNEL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CHANNEL_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of CHANNEL_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function baseConfig(): OpenOmniConfig {
  return {
    dbPath: "/tmp/openomni-channel-test.db",
    memoryPath: "/tmp/openomni-channel-test-memory.json",
    host: "127.0.0.1",
    wsPort: 0,
    model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
  };
}

class FakeSurface implements Channel.Surface {
  readonly config = { triggers: [] };
  handler: Channel.MessageHandler | undefined;

  constructor(readonly id: string) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(_traceId: string): Promise<void> {
    // Lifecycle is observed through composition only.
  }

  stop(_traceId: string): void {
    // Lifecycle is observed through composition only.
  }

  async deliver(externalId: string, body: string) {
    return { externalMessageId: `${externalId}:${body}` };
  }
}

class FakeGitHubSurface extends FakeSurface {
  constructor() {
    super("github");
  }

  async handleWebhook(_request: Request): Promise<Response> {
    return new Response("github handled", { status: 202 });
  }
}

describe("OpenOmni channel composition", () => {
  it("keeps channel config absent when no channel credentials are set", () => {
    process.env.OPENOMNI_MODEL_PROVIDER = "fake";
    process.env.OPENOMNI_MODEL_ID = "resident-test";
    process.env.OPENOMNI_MODEL_API_KEY = "test-key";

    const config = loadConfig();

    expect(config.channels).toBeUndefined();
    const composed = createChannelDrivers(config, async () => null);
    expect(composed.surfaces).toEqual([]);
    expect(composed.deliveryRoutes.size).toBe(0);
    expect(composed.githubWebhookHandler).toBeUndefined();
  });

  it("reads only present credentials into channel config", () => {
    process.env.OPENOMNI_MODEL_PROVIDER = "fake";
    process.env.OPENOMNI_MODEL_ID = "resident-test";
    process.env.OPENOMNI_MODEL_API_KEY = "test-key";
    process.env.DISCORD_BOT_TOKEN = " discord-token ";
    process.env.GITHUB_WEBHOOK_SECRET = " github-secret ";
    process.env.GITHUB_TOKEN = " github-token ";
    process.env.GITHUB_BOT_USERNAME = " resident-bot ";

    expect(loadConfig().channels).toEqual({
      discord: { token: "discord-token" },
      github: {
        secret: "github-secret",
        token: "github-token",
        botUsername: "resident-bot",
      },
    });
  });

  it("registers configured drivers and their existing delivery/webhook seams", async () => {
    const discord = new FakeSurface("discord");
    const telegram = new FakeSurface("telegram");
    const github = new FakeGitHubSurface();
    const handler: Channel.MessageHandler = async () => ({ text: "resident reply" });
    const config: OpenOmniConfig = {
      ...baseConfig(),
      channels: {
        discord: { token: "discord-token" },
        telegram: { token: "telegram-token" },
        github: { secret: "github-secret" },
      },
    };

    const composed = createChannelDrivers(config, handler, {
      discord: () => discord,
      telegram: () => telegram,
      github: () => github,
    });

    expect(composed.surfaces.map((surface) => surface.id)).toEqual([
      "telegram",
      "github",
      "discord",
    ]);
    expect(discord.handler).toBe(handler);
    expect(telegram.handler).toBe(handler);
    expect(github.handler).toBe(handler);
    const discordRoute = composed.deliveryRoutes.get("discord");
    const telegramRoute = composed.deliveryRoutes.get("telegram");
    if (discordRoute === undefined || telegramRoute === undefined) {
      throw new Error("configured delivery route missing");
    }
    expect(await discordRoute("user-1", "hello", "send-1")).toEqual({
      externalMessageId: "user-1:hello",
    });
    expect(await telegramRoute("chat-1", "hello", "send-2")).toEqual({
      externalMessageId: "chat-1:hello",
    });
    expect(composed.deliveryRoutes.has("github")).toBe(false);
    const webhook = composed.githubWebhookHandler;
    if (webhook === undefined) throw new Error("configured GitHub webhook missing");
    expect(await webhook(new Request("http://localhost/github/webhook"))).toMatchObject({
      status: 202,
    });
  });
});
