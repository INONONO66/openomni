import { afterEach, describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import { DiscordApiError, DiscordGatewayFetchError, DiscordHandlerMissingError } from "../src/provider/discord/error";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { DiscordAdapter } from "../src/provider/discord/surface";
import type { DiscordMessage } from "../src/provider/discord/types";
import { bounded } from "./helpers/bounded";

interface DiscordAdapterHarness {
  botId: string | null;
  normalizer: DiscordNormalizer | null;
  handleMessageCreate(message: DiscordMessage, traceId: string): void;
}
const message: DiscordMessage = {
  id: "message-1", channel_id: "channel-1", author: { id: "user-1", username: "user" }, content: "hello",
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("Discord audit regressions", () => {
  it("releases a rejected ingress attempt for platform redelivery", async () => {
    const failed = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    let handlerAttempts = 0;
    const adapter = new DiscordAdapter("token", {}, (event) => {
      if (event.name === Operational.Events.Error.name) failed.resolve();
    });
    adapter.onMessage(async () => {
      handlerAttempts += 1;
      if (handlerAttempts === 1) throw new Error("inbox refused");
      retried.resolve();
    });
    const harness = adapter as object as DiscordAdapterHarness;
    harness.botId = "bot-1";
    harness.normalizer = new DiscordNormalizer();
    harness.handleMessageCreate(message, "trace-first");
    await bounded(failed.promise);
    harness.handleMessageCreate(message, "trace-retry");
    await bounded(retried.promise);
    expect(handlerAttempts).toBe(2);
  });

  it("throws a typed error when the gateway URL request fails", async () => {
    globalThis.fetch = Object.assign(async () => new Response("outage", { status: 503 }), { preconnect: realFetch.preconnect });
    const client = new DiscordClient("token", () => undefined);
    await expect(client.fetchGatewayUrl()).rejects.toBeInstanceOf(DiscordGatewayFetchError);
  });

  it("throws a typed error when a Discord API request fails", async () => {
    globalThis.fetch = Object.assign(async () => new Response("forbidden", { status: 403 }), { preconnect: realFetch.preconnect });
    const client = new DiscordClient("token", () => undefined);
    await expect(client.send("channel-1", "hello", "trace-1")).rejects.toBeInstanceOf(DiscordApiError);
  });

  it("throws a typed error when start has no message handler", async () => {
    const adapter = new DiscordAdapter("token", {}, () => undefined);
    await expect(adapter.start("trace-1")).rejects.toBeInstanceOf(DiscordHandlerMissingError);
  });
});
