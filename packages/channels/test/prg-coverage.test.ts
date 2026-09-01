import { afterEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import type { GatewayCallbacks } from "../src/provider/discord/gateway";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import type { TelegramMessage } from "../src/provider/telegram/types";
import { TelegramClient } from "../src/provider/telegram/client";
import { SocketReconnectShell } from "../src/support/socket-shell";
import { DiscordProvider } from "../src/provider/discord/provider";
import { SlackProvider } from "../src/provider/slack/provider";
import { TelegramProvider } from "../src/provider/telegram/provider";
import { evaluateTriggers, normalizeContent } from "../src/support/trigger";
import type { ChannelClient, PublishPort } from "../src/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Published = { event: string; msg?: unknown; context?: Record<string, unknown> };

function collector(): { published: Published[]; publish: PublishPort } {
  const published: Published[] = [];
  const publish = ((event: unknown, data: unknown) =>
    published.push({
      event: String(event),
      ...(data as { msg?: unknown; context?: Record<string, unknown> }),
    })) as PublishPort;
  return { published, publish };
}

const ctx = (overrides: Partial<Channel.TriggerContext>): Channel.TriggerContext => ({
  event: "message",
  mentioned: false,
  senderId: "u1",
  text: "hello",
  ...overrides,
});

describe("evaluateTriggers rule branches", () => {
  it("prefix rule matches only texts starting with the value", () => {
    const rules: Channel.TriggerRule[] = [{ type: "prefix", value: "!" }];
    expect(evaluateTriggers(rules, ctx({ text: "!go" }))).toBe(true);
    expect(evaluateTriggers(rules, ctx({ text: "go" }))).toBe(false);
  });

  it("label rule requires an intersecting label and refuses label-less contexts", () => {
    const rules: Channel.TriggerRule[] = [{ type: "label", values: ["bug"] }];
    expect(evaluateTriggers(rules, ctx({ labels: ["bug", "p1"] }))).toBe(true);
    expect(evaluateTriggers(rules, ctx({ labels: ["p1"] }))).toBe(false);
    expect(evaluateTriggers(rules, ctx({}))).toBe(false);
  });

  it("channel rule matches listed ids and lets DMs through when no channel id exists", () => {
    const rules: Channel.TriggerRule[] = [{ type: "channel", ids: ["c1"] }];
    expect(evaluateTriggers(rules, ctx({ channelId: "c1" }))).toBe(true);
    expect(evaluateTriggers(rules, ctx({ channelId: "c2" }))).toBe(false);
    expect(evaluateTriggers(rules, ctx({ isDM: true }))).toBe(true);
    expect(evaluateTriggers(rules, ctx({}))).toBe(false);
  });

  it("normalizeContent strips a matched trigger prefix", () => {
    expect(normalizeContent("!go now", [{ type: "prefix", value: "!" }])).toBe("go now");
    expect(normalizeContent("go now", [{ type: "prefix", value: "!" }])).toBe("go now");
  });

  it("sender allow-list admits only listed senders; deny wins over allow", () => {
    const allow: Channel.TriggerRule[] = [{ type: "sender", allow: ["u1"] }];
    expect(evaluateTriggers(allow, ctx({ senderId: "u1" }))).toBe(true);
    expect(evaluateTriggers(allow, ctx({ senderId: "u2" }))).toBe(false);
    const deny: Channel.TriggerRule[] = [{ type: "sender", allow: ["u1"], deny: ["u1"] }];
    expect(evaluateTriggers(deny, ctx({ senderId: "u1" }))).toBe(false);
    const denyOnly: Channel.TriggerRule[] = [{ type: "sender", deny: ["u9"] }];
    expect(evaluateTriggers(denyOnly, ctx({ senderId: "u1" }))).toBe(true);
  });
});

const SHELL_MESSAGES = {
  urlFetchFailed: "test url fetch failed, retrying",
  closed: "test connection closed, reconnecting",
  reconnectFailed: "test reconnect failed",
  socketError: "test websocket error",
} as const;

describe("SocketReconnectShell failure paths", () => {
  it("publishes the reconnectFailed message when the scheduled reconnect rejects", async () => {
    const { published } = collector();
    const failed = Promise.withResolvers<void>();
    const observed = ((event: unknown, data: unknown) => {
      published.push({
        event: String(event),
        ...(data as { msg?: unknown; context?: Record<string, unknown> }),
      });
      // Subscribe to the exact published fact — the catch runs after scheduleReconnect resolves.
      if ((data as { msg?: unknown }).msg === SHELL_MESSAGES.reconnectFailed) failed.resolve();
    }) as PublishPort;
    const shell = new SocketReconnectShell(
      observed,
      SHELL_MESSAGES,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    shell.begin();
    await shell.scheduleReconnect(4000, () => Promise.reject(new Error("gateway gone")));
    await failed.promise;
    const error = published.find((entry) => entry.msg === SHELL_MESSAGES.reconnectFailed);
    expect(error?.context?.err).toContain("gateway gone");
  });

  it("socketErrorListener publishes the socketError message", () => {
    const { published, publish } = collector();
    const shell = new SocketReconnectShell(
      publish,
      SHELL_MESSAGES,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    shell.socketErrorListener()(new Event("error"));
    expect(published).toHaveLength(1);
    expect(published[0]?.msg).toBe(SHELL_MESSAGES.socketError);
  });
});

describe("DiscordClient rate-limit and typing failure paths", () => {
  it("reads retry_after from a 429 body and succeeds on the retry", async () => {
    const { published, publish } = collector();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
        : new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new DiscordClient("token", publish);

    const id = await client.send("channel-1", "hello", "trace-1");

    expect(id).toBe("m1");
    expect(calls).toBe(2);
    expect(published.some((entry) => entry.msg === "rate limited, retrying")).toBe(true);
  });

  it("sendTyping failure publishes a warning instead of throwing", async () => {
    const { published, publish } = collector();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new DiscordClient("token", publish);

    await client.sendTyping("channel-1", "trace-1");

    const warn = published.find((entry) => entry.msg === "discord typing indicator failed");
    expect(warn?.context?.err).toContain("network down");
  });
});

describe("TelegramClient rate-limit path", () => {
  it("reads parameters.retry_after from a 429 body and succeeds on the retry", async () => {
    const { published, publish } = collector();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ parameters: { retry_after: 0 } }), { status: 429 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TelegramClient("token", publish);

    const id = await client.send("chat-1", "hello", "trace-1");

    expect(id).toBe("7");
    expect(calls).toBe(2);
    expect(published.some((entry) => entry.msg === "rate limited, retrying")).toBe(true);
  });
});

type DiscordSurfaceHarness = {
  gateway: { callbacks: GatewayCallbacks };
  botId: string | null;
};

describe("DiscordAdapter gateway callbacks", () => {
  it("onReady wires the normalizer and publishes discord bot started", () => {
    const { published, publish } = collector();
    const adapter = new DiscordAdapter("token", { triggers: [] }, publish);
    const harness = adapter as unknown as DiscordSurfaceHarness;

    harness.gateway.callbacks.onReady({ botId: "bot-1", botUsername: "omni" });

    expect(harness.botId).toBe("bot-1");
    const started = published.find((entry) => entry.msg === "discord bot started");
    expect(started?.context?.botId).toBe("bot-1");
  });

  it("a malformed MESSAGE_CREATE payload is dropped with a warning", () => {
    const { published, publish } = collector();
    const adapter = new DiscordAdapter("token", { triggers: [] }, publish);
    const harness = adapter as unknown as DiscordSurfaceHarness;

    harness.gateway.callbacks.onDispatch("MESSAGE_CREATE", { nope: true }, "trace-1");
    harness.gateway.callbacks.onDispatch("TYPING_START", {}, "trace-2");

    const warns = published.filter(
      (entry) => entry.msg === "discord MESSAGE_CREATE payload malformed; dropped",
    );
    expect(warns).toHaveLength(1);
  });
});

type TelegramSurfaceHarness = {
  client: ChannelClient;
  normalizer: object | null;
  handleMessage(message: TelegramMessage, traceId: string): Promise<void>;
};

describe("TelegramAdapter handler error frame", () => {
  it("a handler throw publishes telegram message handler error", async () => {
    const { published, publish } = collector();
    const adapter = new TelegramAdapter("token", { triggers: [] }, publish);
    adapter.onMessage(() => Promise.reject(new Error("boom")));
    const harness = adapter as unknown as TelegramSurfaceHarness;
    const { TelegramNormalizer } = await import("../src/provider/telegram/normalizer");
    harness.normalizer = new TelegramNormalizer({ botId: "bot-1", botUsername: "omni", triggers: [] });
    harness.client = {
      send: () => Promise.resolve(undefined),
      sendMarkdown: () => Promise.resolve(undefined),
      sendTyping: () => Promise.resolve(),
    } as unknown as ChannelClient;

    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 10, type: "private" },
      from: { id: 20, is_bot: false, first_name: "u" },
      text: "hello",
    };
    await harness.handleMessage(message, "trace-1");

    const error = published.find((entry) => entry.msg === "telegram message handler error");
    expect(error?.context?.err).toContain("boom");
  });
});

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("provider deliveryRoute seams", () => {
  it("telegram deliveryRoute delivers by chat id and reports the message id", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ ok: true, result: { message_id: 5 } })) as unknown as typeof fetch;
    const runtime = TelegramProvider.create({ token: "t" }, { triggers: [] }, () => undefined);

    const receipt = await runtime.deliveryRoute?.("100", "hello", "key-1");

    expect(receipt?.externalMessageId).toBe("5");
  });

  it("discord deliveryRoute opens a DM and reports the final message id", async () => {
    globalThis.fetch = (async (input: string | URL | Request) =>
      String(input).endsWith("/users/@me/channels")
        ? jsonResponse({ id: "dm-1" })
        : jsonResponse({ id: "m-9" })) as unknown as typeof fetch;
    const runtime = DiscordProvider.create({ token: "t" }, { triggers: [] }, () => undefined);

    const receipt = await runtime.deliveryRoute?.("user-1", "hello", "key-2");

    expect(receipt?.externalMessageId).toBe("m-9");
  });

  it("slack deliveryRoute opens a DM from the TEAM:USER key and reports the ts", async () => {
    globalThis.fetch = (async (input: string | URL | Request) =>
      String(input).includes("conversations.open")
        ? jsonResponse({ ok: true, channel: { id: "D1" } })
        : jsonResponse({ ok: true, ts: "1.2" })) as unknown as typeof fetch;
    const runtime = SlackProvider.create(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      () => undefined,
    );

    const receipt = await runtime.deliveryRoute?.("T1:U1", "hello", "key-3");

    expect(receipt?.externalMessageId).toBe("1.2");
  });
});
