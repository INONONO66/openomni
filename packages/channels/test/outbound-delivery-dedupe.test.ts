import { afterEach, describe, expect, test } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { DiscordAdapter } from "../src/discord/surface";
import { TelegramAdapter } from "../src/telegram/surface";

const realFetch = globalThis.fetch;
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
