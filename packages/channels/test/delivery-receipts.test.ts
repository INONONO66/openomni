import { expect, test } from "bun:test";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { SlackAdapter } from "../src/provider/slack/surface";
import { TelegramAdapter } from "../src/provider/telegram/surface";

for (const provider of ["discord", "slack", "telegram"] as const) {
  for (const failure of [
    "forbidden",
    "network",
    "server",
    "malformed",
    "missing_id",
    "accepted",
  ] as const) {
    test(`${provider} classifies ${failure} at its real HTTP delivery boundary`, async () => {
      const originalFetch = globalThis.fetch;
      let sends = 0;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm" });
          if (url.endsWith("/conversations.open"))
            return Response.json({ ok: true, channel: { id: "dm" } });
          sends += 1;
          if (failure === "network") throw new TypeError("connection lost after transmission");
          if (failure === "forbidden" || failure === "server")
            return Response.json(
              { ok: false, error: "forbidden", description: "forbidden" },
              { status: failure === "forbidden" ? 403 : 503 },
            );
          if (failure === "malformed") return new Response("not-json");
          if (failure === "missing_id") return Response.json({ ok: true, result: {} });
          return Response.json({
            id: "physical-id",
            ok: true,
            ts: "physical-id",
            result: { message_id: "physical-id" },
          });
        },
        { preconnect: originalFetch.preconnect },
      );
      const adapter =
        provider === "discord"
          ? new DiscordAdapter("token", {}, () => undefined)
          : provider === "slack"
            ? new SlackAdapter({ botToken: "token", appToken: "app" }, {}, () => undefined)
            : new TelegramAdapter("token", {}, () => undefined);
      try {
        const address = provider === "slack" ? "TEAM:USER" : "123";
        const receipt = await adapter.deliver(address, "SENTINEL", "stable-key");
        expect(sends).toBe(1);
        expect(receipt).toEqual(
          failure === "accepted"
            ? { value: "accepted", externalMessageId: "physical-id" }
            : { value: failure === "forbidden" ? "rejected" : "unknown" },
        );
        expect(await adapter.deliver(address, "SENTINEL", "stable-key")).toEqual(receipt);
        expect(sends).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

test("invalid Slack destination throws before any HTTP request or external receipt", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const adapter = new SlackAdapter({ botToken: "token", appToken: "app" }, {}, () => undefined);
    await expect(adapter.deliver("USER", "message", "invalid")).rejects.toMatchObject({
      name: "SlackEndpointKeyError",
    });
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
