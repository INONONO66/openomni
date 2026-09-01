import type { ChannelProvider } from "../provider/contract.js";
import { DiscordAdapter } from "./surface.js";

export interface DiscordCredentials {
  /** Bot token from the developer portal. */
  readonly token: string;
}

/**
 * Discord: one bot token over the gateway socket, DM delivery by user id.
 * Operator precondition the credential cannot carry: the MESSAGE CONTENT
 * gateway intent must be enabled in the developer portal, or every inbound
 * `content` arrives empty.
 */
export const DiscordProvider: ChannelProvider<DiscordCredentials, "discord"> = {
  id: "discord",
  ingest: "socket",
  capabilities: { deliver: true, webhook: false },
  create(credentials, config, publish) {
    const surface = new DiscordAdapter(credentials.token, config, publish);
    return {
      surface,
      deliveryRoute: (externalId, body, idempotencyKey) =>
        surface.deliver(externalId, body, idempotencyKey),
    };
  },
};
