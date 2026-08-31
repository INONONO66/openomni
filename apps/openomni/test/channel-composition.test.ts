import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { channelProfile } from "../src/channels";
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
    expect(channelProfile(config)).toEqual([]);
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

  it("profiles one row per configured channel and binds its delivery/webhook seams", async () => {
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

    const rows = channelProfile(config, {
      discord: () => discord,
      telegram: () => telegram,
      github: () => github,
    });

    // One declarative row per configured channel, in composition order.
    expect(rows.map((row) => row.id)).toEqual(["telegram", "github", "discord"]);
    const built = rows.map((row) => row.build(handler));
    expect(built.map((channel) => channel.surface.id)).toEqual(["telegram", "github", "discord"]);
    expect(discord.handler).toBe(handler);
    expect(telegram.handler).toBe(handler);
    expect(github.handler).toBe(handler);

    const [telegramBuilt, githubBuilt, discordBuilt] = built;
    if (telegramBuilt?.deliveryRoute === undefined || discordBuilt?.deliveryRoute === undefined) {
      throw new Error("configured delivery route missing");
    }
    expect(await discordBuilt.deliveryRoute("user-1", "hello", "send-1")).toEqual({
      externalMessageId: "user-1:hello",
    });
    expect(await telegramBuilt.deliveryRoute("chat-1", "hello", "send-2")).toEqual({
      externalMessageId: "chat-1:hello",
    });
    // GitHub is ingress-only: webhook seam present, outbound route absent.
    expect(githubBuilt?.deliveryRoute).toBeUndefined();
    const webhook = githubBuilt?.webhookHandler;
    if (webhook === undefined) throw new Error("configured GitHub webhook missing");
    expect(await webhook(new Request("http://localhost/github/webhook"))).toMatchObject({
      status: 202,
    });
  });

  it("builds the real channel adapters when no factories are injected", () => {
    const handler: Channel.MessageHandler = async () => ({ text: "resident reply" });
    const config: OpenOmniConfig = {
      ...baseConfig(),
      channels: {
        discord: { token: "discord-token" },
        telegram: { token: "telegram-token" },
        github: { secret: "github-secret" },
      },
    };

    // Construction only — adapters connect in start(), which is never called.
    const built = channelProfile(config).map((row) => row.build(handler));

    expect(built.map((channel) => channel.surface.id)).toEqual(["telegram", "github", "discord"]);
    const [telegram, github, discord] = built;
    expect(telegram?.deliveryRoute).toBeDefined();
    expect(discord?.deliveryRoute).toBeDefined();
    expect(github?.deliveryRoute).toBeUndefined();
    expect(github?.webhookHandler).toBeDefined();
  });
});
