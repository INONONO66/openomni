import type { ChannelProvider } from "../provider/contract.js";
import { SlackAdapter } from "./surface.js";

export interface SlackCredentials {
  /** Bot token (`xoxb-`): identity, posting, DMs. */
  readonly botToken: string;
  /** App-level token (`xapp-`) with `connections:write`: opens the Socket Mode URL, nothing else. */
  readonly appToken: string;
}

/**
 * Slack over Socket Mode: two tokens by platform design, no public HTTP
 * ingress. Endpoint keys are workspace-mandatory — externalIds are
 * `TEAM:USER` pairs because slack user ids are only unique per workspace
 * (docs/provisioning-and-providers.md §endpoint-keys). Operator precondition
 * the credentials cannot carry: Socket Mode enabled plus the
 * `message.channels`/`message.im` event subscriptions and
 * `chat:write`/`im:write` bot scopes.
 */
export const SlackProvider: ChannelProvider<SlackCredentials, "slack"> = {
  id: "slack",
  ingest: "socket",
  capabilities: { deliver: true, webhook: false },
  create(credentials, config, publish) {
    const surface = new SlackAdapter(credentials, config, publish);
    return {
      surface,
      deliveryRoute: (externalId, body, idempotencyKey) =>
        surface.deliver(externalId, body, idempotencyKey),
    };
  },
};
