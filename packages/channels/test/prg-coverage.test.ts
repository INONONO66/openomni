import { afterEach, describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import { DiscordAdapter } from "../src/provider/discord/surface";
import type { GatewayCallbacks } from "../src/provider/discord/gateway";
import { DiscordProvider } from "../src/provider/discord/provider";
import { SlackProvider } from "../src/provider/slack/provider";
import { TelegramClient } from "../src/provider/telegram/client";
import { TelegramProvider } from "../src/provider/telegram/provider";
import type { PublishPort } from "../src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function collector(): { published: string[]; publish: PublishPort } {
  const published: string[] = [];
  return {
    published,
    publish: (event) => {
      published.push(event.name);
    },
  };
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("provider retry and receipt paths", () => {
  it("retries Discord rate limits and returns the platform id", async () => {
    const { published, publish } = collector();
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
          : new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      },
      { preconnect: () => undefined },
    );
    const id = await new DiscordClient("token", publish).send("channel-1", "hello", "trace-1");
    expect(id).toBe("m1");
    expect(calls).toBe(2);
    expect(published).toContain(Operational.Events.Warn.name);
  });

  it("retries Telegram rate limits and returns the platform id", async () => {
    const { published, publish } = collector();
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ parameters: { retry_after: 0 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
      },
      { preconnect: () => undefined },
    );
    const id = await new TelegramClient("token", publish).send("chat-1", "hello", "trace-1");
    expect(id).toBe("7");
    expect(calls).toBe(2);
    expect(published).toContain(Operational.Events.Warn.name);
  });

  it("provider delivery routes return accepted receipts", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("conversations.open"))
        return jsonResponse({ ok: true, channel: { id: "D1" } });
      if (url.endsWith("/users/@me/channels")) return jsonResponse({ id: "dm-1" });
      if (url.includes("api.telegram.org"))
        return jsonResponse({ ok: true, result: { message_id: 5 } });
      if (url.includes("slack.com")) return jsonResponse({ ok: true, ts: "1.2" });
      return jsonResponse({ id: "m-9" });
    }) as typeof fetch;

    const telegram = await TelegramProvider.create(
      { token: "t" },
      {},
      () => undefined,
    ).deliveryRoute?.("100", "hello", "key-1");
    const discord = await DiscordProvider.create(
      { token: "t" },
      {},
      () => undefined,
    ).deliveryRoute?.("user-1", "hello", "key-2");
    const slack = await SlackProvider.create(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      {},
      () => undefined,
    ).deliveryRoute?.("T1:U1", "hello", "key-3");

    expect(telegram).toEqual({ value: "accepted", externalMessageId: "5" });
    expect(discord).toEqual({ value: "accepted", externalMessageId: "m-9" });
    expect(slack).toEqual({ value: "accepted", externalMessageId: "1.2" });
  });
});

describe("Discord gateway surface", () => {
  it("drops malformed message payloads with an operational warning", () => {
    const { published, publish } = collector();
    const adapter = new DiscordAdapter("token", {}, publish);
    const harness = adapter as object as { gateway: { callbacks: GatewayCallbacks } };
    harness.gateway.callbacks.onDispatch("MESSAGE_CREATE", { nope: true }, "trace-1");
    harness.gateway.callbacks.onDispatch("TYPING_START", {}, "trace-2");
    expect(published.filter((name) => name === Operational.Events.Warn.name)).toHaveLength(1);
  });
});
