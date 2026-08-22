import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { DiscordAdapter } from "../src/discord/surface";
import { TelegramAdapter } from "../src/telegram/surface";

/**
 * D1: telegram message_id is a PER-CHAT counter, so two different chats can
 * legitimately share one id inside the dedupe window. The surface must key
 * dedupe on `${chat.id}:${message_id}` — keying on the bare message_id
 * silently dropped the second chat's message with no trace.
 */

const realFetch = globalThis.fetch;

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tgMessage(messageId: number, chatId: number, text: string): Record<string, unknown> {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" },
    from: { id: chatId, username: `u${chatId}` },
    text,
  };
}

describe("TelegramAdapter dedupe (D1)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    let getUpdatesCall = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return jsonResponse({ id: 42, username: "bot", first_name: "Bot" });
      }
      if (url.endsWith("/getUpdates")) {
        getUpdatesCall += 1;
        if (getUpdatesCall === 1) {
          // Same message_id (100) across two distinct chats within the window.
          return jsonResponse([
            { update_id: 1, message: tgMessage(100, 111, "hello from chat one") },
            { update_id: 2, message: tgMessage(100, 222, "hello from chat two") },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      // sendChatAction / sendMessage / anything else
      return jsonResponse(true);
    }) as typeof fetch;
  });

  it("delivers same message_id from two different chats (no cross-chat collision)", async () => {
    const delivered: Channel.InboundMessage[] = [];
    const deliveredBoth = Promise.withResolvers<void>();
    const adapter = new TelegramAdapter("test-token", { triggers: [] }, () => undefined);
    adapter.onMessage(async (message) => {
      delivered.push(message);
      if (delivered.length === 2) deliveredBoth.resolve();
      return null;
    });

    await adapter.start("trace-dedupe-test");
    await deliveredBoth.promise;
    adapter.stop("trace-dedupe-test");

    expect(delivered).toHaveLength(2);
    const surfaceKeys = delivered.map((m) => m.surfaceKey).sort();
    expect(new Set(surfaceKeys).size).toBe(2);
    expect(surfaceKeys.some((k) => k.includes("111"))).toBe(true);
    expect(surfaceKeys.some((k) => k.includes("222"))).toBe(true);
  });
});

const config = { triggers: [] } satisfies Channel.Config;
type DeliveryOwner = Readonly<{
  deliver(externalId: string, body: string, idempotencyKey?: string): Promise<{
    externalMessageId?: string;
  }>;
}>;

function telegramFixture(): { owner: DeliveryOwner; outboundCalls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/sendMessage")) throw new Error(`unexpected request: ${input}`);
    calls += 1;
    return Response.json({ ok: true, result: { message_id: calls } });
  }) as typeof fetch;
  return {
    owner: new TelegramAdapter("token", config, () => undefined),
    outboundCalls: () => calls,
  };
}

function discordFixture(): { owner: DeliveryOwner; outboundCalls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
    if (url.endsWith("/channels/dm-1/messages")) {
      calls += 1;
      return Response.json({ id: `discord-message-${calls}` });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return {
    owner: new DiscordAdapter("token", config, () => undefined),
    outboundCalls: () => calls,
  };
}

const owners = [
  ["Telegram", telegramFixture],
  ["Discord", discordFixture],
] as const;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("outbound adapter delivery dedupe capability", () => {
  test.each(owners)("%s reuses one outbound result when an idempotency key is supplied", async (
    _name,
    fixture,
  ) => {
    const { owner, outboundCalls } = fixture();

    const [first, retry] = await Promise.all([
      owner.deliver("recipient-1", "hello", "gateway-message-1"),
      owner.deliver("recipient-1", "hello", "gateway-message-1"),
    ]);

    expect(outboundCalls()).toBe(1);
    expect(retry).toEqual(first);
  });

  test.each(owners)("%s remains at-least-once when no idempotency key is supplied", async (
    _name,
    fixture,
  ) => {
    const { owner, outboundCalls } = fixture();

    await owner.deliver("recipient-1", "hello");
    await owner.deliver("recipient-1", "hello");

    // This is the current production path: frozen apps/server wiring drops
    // the key, so retries can create a second platform message.
    expect(outboundCalls()).toBe(2);
  });
});
