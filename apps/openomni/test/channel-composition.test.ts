import { describe, expect, test } from "bun:test";
import { fakeProviders, type FakeBuild } from "./helpers/channel-providers";
import type { Channel } from "@openomni/protocol";
import { type BuiltChannel, channelProfile } from "../src/channels";
import { loadConfig, type OpenOmniConfig } from "../src/config";
import { replaceEnvironment } from "./helpers/environment";

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

const handler: Channel.MessageHandler = () => Promise.resolve();

function build(config: OpenOmniConfig, fakes: FakeBuild): BuiltChannel[] {
  return channelProfile(config, fakes.providers).map((row) => row.build(handler));
}

describe("channelProfile", () => {
  test.each([false, true])("real environment parity with configured channels: %s", (enabled) => {
    const restore = replaceEnvironment({
      OPENOMNI_MODEL_PROVIDER: "anthropic",
      OPENOMNI_MODEL_ID: "fixture",
      OPENOMNI_MODEL_API_KEY: "fixture-key",
      TELEGRAM_BOT_TOKEN: enabled ? " tg-token " : " ",
      DISCORD_BOT_TOKEN: enabled ? " dc-token " : "",
      GITHUB_WEBHOOK_SECRET: enabled ? " gh-secret " : undefined,
      GITHUB_TOKEN: enabled ? " gh-api " : undefined,
      GITHUB_BOT_USERNAME: enabled ? " omni-bot " : undefined,
    });
    try {
      const fakes = fakeProviders();
      const config = loadConfig();
      const rows = channelProfile(config, fakes.providers);
      expect(rows.map((row) => row.id)).toEqual(enabled ? ["telegram", "github", "discord"] : []);
      for (const row of rows) row.build(handler);
      expect(fakes.surfaces.map((surface) => surface.credentials)).toEqual(enabled ? [
        { token: "tg-token" },
        { secret: "gh-secret", token: "gh-api", botUsername: "omni-bot" },
        { token: "dc-token" },
      ] : []);
      expect(fakes.surfaces.every((surface) => surface.handler === handler)).toBe(true);
    } finally {
      restore();
    }
  });
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
