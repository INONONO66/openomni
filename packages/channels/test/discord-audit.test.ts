import { afterEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import {
  DiscordApiError,
  DiscordGatewayFetchError,
  DiscordHandlerMissingError,
} from "../src/provider/discord/error";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { DiscordAdapter } from "../src/provider/discord/surface";
import type { DiscordMessage } from "../src/provider/discord/types";
import type { ChannelClient } from "../src/types";

type DiscordAdapterHarness = {
  botId: string | null;
  client: ChannelClient;
  handleMessageCreate(message: DiscordMessage, traceId: string): void;
  normalizer: DiscordNormalizer | null;
};

const message: DiscordMessage = {
  id: "message-1",
  channel_id: "channel-1",
  author: { id: "user-1", username: "user" },
  content: "hello",
};

const config = { triggers: [] } satisfies Channel.Config;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Discord audit regressions", () => {
  it("releases a failed inbound attempt so Discord can redeliver the same event", async () => {
    const failed = Promise.withResolvers<void>();
    let handlerAttempts = 0;
    const adapter = new DiscordAdapter("token", config, (_event, data) => {
      const payload = data as { msg?: unknown };
      if (payload.msg === "discord message handling failed") failed.resolve();
    });
    adapter.onMessage(async () => {
      handlerAttempts += 1;
      return { text: "reply" };
    });

    const harness = adapter as unknown as DiscordAdapterHarness;
    harness.botId = "bot-1";
    harness.normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });
    harness.client = {
      send: () => Promise.reject(new Error("Discord unavailable")),
      sendTyping: () => Promise.resolve(),
    };

    harness.handleMessageCreate(message, "trace-first");
    await failed.promise;
    harness.handleMessageCreate(message, "trace-retry");

    expect(handlerAttempts).toBe(2);
  });

  it("throws a typed error when the gateway URL request fails", async () => {
    globalThis.fetch = (async () =>
      new Response("outage", { status: 503 })) as unknown as typeof fetch;
    const client = new DiscordClient("token", () => undefined);

    const error = await client.fetchGatewayUrl().catch((caught: unknown) => caught);

    expect(DiscordGatewayFetchError.isInstance(error)).toBe(true);
    expect((error as Error).name).toBe("DiscordGatewayFetchError");
  });

  it("throws a typed error when a Discord API request fails", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const client = new DiscordClient("token", () => undefined);

    const error = await client.send("channel-1", "hello", "trace-1").catch((caught: unknown) => caught);

    expect(DiscordApiError.isInstance(error)).toBe(true);
    expect((error as Error).name).toBe("DiscordApiError");
  });

  it("throws a typed error when start has no message handler", async () => {
    const adapter = new DiscordAdapter("token", config, () => undefined);

    const error = await adapter.start("trace-1").catch((caught: unknown) => caught);

    expect(DiscordHandlerMissingError.isInstance(error)).toBe(true);
    expect((error as Error).name).toBe("DiscordHandlerMissingError");
  });
});
