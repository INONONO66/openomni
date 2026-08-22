import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
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
