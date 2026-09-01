import { afterEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { DiscordAdapter } from "../src/discord/surface";
import { GitHubAdapter } from "../src/github/surface";
import { TelegramClient } from "../src/telegram/client";

const config = { triggers: [] } satisfies Channel.Config;
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
    const events: unknown[] = [];
    const adapter = new GitHubAdapter("secret", config, (_event, data) => {
      events.push(data);
    });
    adapter.onMessage(async () => null);
    await adapter.start("trace-gh-2");
    adapter.stop("trace-gh-2");
    expect(
      events.some((entry) => (entry as { msg?: unknown }).msg === "github webhook handler ready"),
    ).toBe(true);
  });
});

describe("DiscordAdapter lifecycle", () => {
  it("stop publishes shutdown and is safe before start", () => {
    const events: unknown[] = [];
    const adapter = new DiscordAdapter("token", config, (_event, data) => {
      events.push(data);
    });
    adapter.stop("trace-dc-1");
    expect(
      events.some((entry) => (entry as { msg?: unknown }).msg === "discord bot stopped"),
    ).toBe(true);
  });
});

describe("TelegramClient send result normalization", () => {
  const jsonResponse = (result: unknown) =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("returns the message id when Telegram provides one", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({ message_id: 42 }))) as unknown as typeof fetch;
    const client = new TelegramClient("token", () => undefined);
    expect(await client.send("chat-1", "hi", "trace-1")).toBe("42");
  });

  it("returns undefined when Telegram omits the message id", async () => {
    globalThis.fetch = (() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;
    const client = new TelegramClient("token", () => undefined);
    expect(await client.send("chat-1", "hi", "trace-1")).toBeUndefined();
  });

  it("swallows typing indicator failures as warnings", async () => {
    const events: unknown[] = [];
    globalThis.fetch = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const client = new TelegramClient("token", (_event, data) => {
      events.push(data);
    });
    await client.sendTyping("chat-1", "trace-2");
    expect(
      events.some(
        (entry) => (entry as { msg?: unknown }).msg === "telegram typing indicator failed",
      ),
    ).toBe(true);
  });
});
