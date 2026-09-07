import { describe, expect, test } from "bun:test";
import { type ChannelProvider, ChannelProviders as RealProviders } from "@openomni/channels";
import type { Channel } from "@openomni/protocol";
import { type BuiltChannel, channelProfile } from "../src/channels";
import type { OpenOmniConfig } from "../src/config";

/**
 * The channel profile is the app's declarative composition of external
 * channels: which providers mount, with which credentials and triggers, and
 * which seams (delivery, webhook) each row exposes. These tests pin that
 * composition as behavior — a row exists iff its channel is configured, the
 * credential is parsed through the provider's schema, and the handler binds
 * before any seam is exposed.
 */

function baseConfig(channels?: OpenOmniConfig["channels"]): OpenOmniConfig {
  return {
    dbPath: ":memory:",
    host: "127.0.0.1",
    wsPort: 0,
    model: { provider: "anthropic", id: "claude", apiKey: "k" },
    ...(channels === undefined ? {} : { channels }),
  };
}

class FakeSurface implements Channel.Surface {
  handler: Channel.MessageHandler | null = null;
  started = false;
  stopped = false;

  constructor(
    readonly id: string,
    readonly config: Channel.Config,
    readonly credentials: unknown,
  ) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  start(_traceId: string): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(_traceId: string): void {
    this.stopped = true;
  }
}

interface FakeBuild {
  surfaces: FakeSurface[];
  providers: typeof RealProviders;
  delivered: { externalId: string; body: string }[];
  webhookCalls: Request[];
}

/**
 * Fake providers that keep the real registry's ids, schemas, and capability
 * declarations but construct recording surfaces instead of live adapters —
 * the profile's own logic (row existence, credential parse, handler binding,
 * seam shaping) runs unmodified.
 */
function fakeProviders(): FakeBuild {
  const surfaces: FakeSurface[] = [];
  const delivered: { externalId: string; body: string }[] = [];
  const webhookCalls: Request[] = [];
  const telegram: ChannelProvider<TelegramCredentials, "telegram"> = {
    ...RealProviders.telegram,
    create(credentials, config) {
      const surface = new FakeSurface("telegram", config, credentials);
      surfaces.push(surface);
      return {
        surface,
        deliveryRoute: (externalId, body) => {
          delivered.push({ externalId, body });
          return Promise.resolve({ value: "accepted" as const, externalMessageId: "tg-1" });
        },
      };
    },
  };
  const discord: ChannelProvider<DiscordCredentials, "discord"> = {
    ...RealProviders.discord,
    create(credentials, config) {
      const surface = new FakeSurface("discord", config, credentials);
      surfaces.push(surface);
      return {
        surface,
        deliveryRoute: (externalId, body) => {
          delivered.push({ externalId, body });
          return Promise.resolve({ value: "accepted" as const, externalMessageId: "dc-1" });
        },
      };
    },
  };
  const github: ChannelProvider<GitHubCredentials, "github"> = {
    ...RealProviders.github,
    create(credentials, config) {
      const surface = new FakeSurface("github", config, credentials);
      surfaces.push(surface);
      return {
        surface,
        webhookHandler: (request) => {
          webhookCalls.push(request);
          return Promise.resolve(new Response("OK", { status: 200 }));
        },
      };
    },
  };
  const slack: ChannelProvider<SlackCredentials, "slack"> = {
    ...RealProviders.slack,
    create(credentials, config) {
      const surface = new FakeSurface("slack", config, credentials);
      surfaces.push(surface);
      return {
        surface,
        deliveryRoute: (externalId, body) => {
          delivered.push({ externalId, body });
          return Promise.resolve({ value: "accepted" as const, externalMessageId: "sl-1" });
        },
      };
    },
  };
  return { surfaces, providers: { telegram, discord, github, slack }, delivered, webhookCalls };
}

const handler: Channel.MessageHandler = () => Promise.resolve();

function build(config: OpenOmniConfig, fakes: FakeBuild): BuiltChannel[] {
  return channelProfile(config, fakes.providers).map((row) => row.build(handler));
}

type TelegramCredentials = Readonly<{ token: string }>;
type DiscordCredentials = Readonly<{ token: string }>;
type GitHubCredentials = Readonly<{ secret: string; token?: string; botUsername?: string }>;
type SlackCredentials = Readonly<{ botToken: string; appToken: string }>;

describe("channelProfile", () => {
  test("no channel config produces no rows", () => {
    expect(channelProfile(baseConfig(), fakeProviders().providers)).toEqual([]);
  });

  test("a row exists per configured channel, in composition order", () => {
    const fakes = fakeProviders();
    const rows = channelProfile(
      baseConfig({
        telegram: { token: "tg-token" },
        github: { secret: "gh-secret" },
        discord: { token: "dc-token" },
      }),
      fakes.providers,
    );
    expect(rows.map((row) => row.id)).toEqual(["telegram", "github", "discord"]);
  });

  test("build binds the handler and shapes seams per capability", async () => {
    const fakes = fakeProviders();
    const built = build(
      baseConfig({
        telegram: { token: "tg-token" },
        github: { secret: "gh-secret", token: "gh-api", botUsername: "omni-bot" },
        discord: { token: "dc-token" },
      }),
      fakes,
    );

    expect(fakes.surfaces.map((surface) => surface.handler)).toEqual([handler, handler, handler]);

    const [telegram, github, discord] = built as [BuiltChannel, BuiltChannel, BuiltChannel];
    expect(telegram.deliveryRoute).toBeDefined();
    expect(telegram.webhookHandler).toBeUndefined();
    expect(discord.deliveryRoute).toBeDefined();
    expect(discord.webhookHandler).toBeUndefined();
    expect(github.deliveryRoute).toBeUndefined();
    expect(github.webhookHandler).toBeDefined();

    await telegram.deliveryRoute?.("actor-1", "hello", "key-1");
    expect(fakes.delivered).toEqual([{ externalId: "actor-1", body: "hello" }]);

    const response = await github.webhookHandler?.(new Request("https://x.test/webhook"));
    expect(response?.status).toBe(200);
    expect(fakes.webhookCalls).toHaveLength(1);
  });

  test("credentials flow to the provider as configured", () => {
    const fakes = fakeProviders();
    build(
      baseConfig({
        github: { secret: "gh-secret", token: "gh-api", botUsername: "omni-bot" },
      }),
      fakes,
    );
    expect(fakes.surfaces[0]?.credentials).toEqual({
      secret: "gh-secret",
      token: "gh-api",
      botUsername: "omni-bot",
    });
  });

  test("providers receive no trigger policy", () => {
    const fakes = fakeProviders();
    build(
      baseConfig({
        telegram: { token: "tg-token" },
        github: { secret: "gh-secret" },
        discord: { token: "dc-token" },
      }),
      fakes,
    );
    const byId = new Map(fakes.surfaces.map((surface) => [surface.id, surface.config]));
    expect(byId.get("telegram")).toEqual({});
    expect(byId.get("discord")).toEqual({});
    expect(byId.get("github")).toEqual({});
  });
});
