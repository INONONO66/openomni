import { afterEach, describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import type { z } from "zod";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { GitHubAdapter } from "../src/provider/github/surface";
import { TelegramClient } from "../src/provider/telegram/client";

const config = {};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GitHubAdapter lifecycle", () => {
  it("refuses to start without a message handler", async () => {
    const adapter = new GitHubAdapter("secret", config, () => undefined);
    await expect(adapter.start("trace-gh-1")).rejects.toThrow(
      "[github] No message handler registered. Call onMessage() before start().",
    );
  });

  it("starts after a handler is registered and publishes readiness", async () => {
    const events: z.infer<typeof Operational.Events.Info.schema>[] = [];
    const adapter = new GitHubAdapter("secret", config, (event, data) => {
      expect(event.name).toBe(Operational.Events.Info.name);
      events.push(Operational.Events.Info.schema.parse(data));
    });
    adapter.onMessage(async () => undefined);
    await adapter.start("trace-gh-2");
    adapter.stop("trace-gh-2");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ traceId: "trace-gh-2", component: "server" });
  });
});

describe("DiscordAdapter lifecycle", () => {
  it("stop publishes shutdown and is safe before start", () => {
    const events: z.infer<typeof Operational.Events.Info.schema>[] = [];
    const adapter = new DiscordAdapter("token", config, (event, data) => {
      expect(event.name).toBe(Operational.Events.Info.name);
      events.push(Operational.Events.Info.schema.parse(data));
    });
    adapter.stop("trace-dc-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ traceId: "trace-dc-1", component: "server" });
  });
});

describe("TelegramClient send result normalization", () => {
  const jsonResponse = (result: { message_id?: number }) =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("returns the message id when Telegram provides one", async () => {
    globalThis.fetch = Object.assign(async () => jsonResponse({ message_id: 42 }), {
      preconnect: realFetch.preconnect,
    });
    const client = new TelegramClient("token", () => undefined);
    expect(await client.send("chat-1", "hi", "trace-1")).toBe("42");
  });

  it("returns undefined when Telegram omits the message id", async () => {
    globalThis.fetch = Object.assign(async () => jsonResponse({}), {
      preconnect: realFetch.preconnect,
    });
    const client = new TelegramClient("token", () => undefined);
    expect(await client.send("chat-1", "hi", "trace-1")).toBeUndefined();
  });
});
