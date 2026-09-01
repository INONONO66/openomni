import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { TELEGRAM_RENDER } from "./format.js";
import { TelegramAdapter } from "./surface.js";

export interface TelegramCredentials {
  /** BotFather bot token. */
  readonly token: string;
}

/** Telegram: one BotFather token, ordered long-poll ingress, DM delivery by chat id. */
export const TelegramProvider: ChannelProvider<TelegramCredentials, "telegram"> = {
  id: "telegram",
  ingest: "poll",
  capabilities: { deliver: true, webhook: false, render: TELEGRAM_RENDER },
  credentials: z.object({ token: z.string().min(1) }).strict(),
  settings: z.record(z.never()),
  preconditions: [],
  create(credentials, config, publish) {
    const surface = new TelegramAdapter(credentials.token, config, publish);
    return {
      surface,
      deliveryRoute: (externalId, body, idempotencyKey) =>
        surface.deliver(externalId, body, idempotencyKey),
    };
  },
};
