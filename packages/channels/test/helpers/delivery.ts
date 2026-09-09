import { DiscordAdapter } from "../../src/provider/discord/surface";
import { SlackAdapter } from "../../src/provider/slack/surface";
import { TelegramAdapter } from "../../src/provider/telegram/surface";
import { ChannelProviders } from "../../src/provider/registry";
import type { PublishPort } from "../../src/types";

type Provider = "discord" | "slack" | "telegram";

export function deliveryFixture(provider: Provider, publish: PublishPort = () => undefined) {
  const adapter =
    provider === "discord"
      ? new DiscordAdapter("token", {}, publish)
      : provider === "slack"
        ? new SlackAdapter({ botToken: "token", appToken: "app" }, {}, publish)
        : new TelegramAdapter("token", {}, publish);
  const limit = ChannelProviders[provider].capabilities.render.messageLimit;
  if (limit === null) throw new Error("delivery fixture requires a bounded provider");
  return { adapter, limit, address: provider === "slack" ? "TEAM:USER" : "123" };
}

export function installDeliveryFetch(send: () => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm" });
      if (url.endsWith("/conversations.open"))
        return Response.json({ ok: true, channel: { id: "dm" } });
      if (
        !["/channels/dm/messages", "/chat.postMessage", "/sendMessage"].some((path) =>
          url.endsWith(path),
        )
      )
        throw new Error(`unexpected delivery request: ${url}`);
      return await send();
    },
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
}
