import type { ChannelProvider } from "../provider/contract.js";
import { TelegramAdapter } from "./surface.js";

export interface TelegramCredentials {
  /** BotFather bot token. */
  readonly token: string;
}

/** Telegram: one BotFather token, ordered long-poll ingress, DM delivery by chat id. */
export const TelegramProvider: ChannelProvider<TelegramCredentials, "telegram"> = {
  id: "telegram",
  ingest: "poll",
  capabilities: { deliver: true, webhook: false },
  create(credentials, config, publish) {
    const surface = new TelegramAdapter(credentials.token, config, publish);
    return {
      surface,
      deliveryRoute: (externalId, body, idempotencyKey) =>
        surface.deliver(externalId, body, idempotencyKey),
    };
  },
};
