import type { ChannelProvider } from "../provider/contract.js";
import { GitHubAdapter } from "./surface.js";

export interface GitHubCredentials {
  /** HMAC secret verifying webhook deliveries — the one required field. */
  readonly secret: string;
  /** API token for posting reply comments; absent leaves the channel ingress-only. */
  readonly token?: string;
  /** The bot's own login, filtered from mention triggers and self-echoes. */
  readonly botUsername?: string;
}

/** GitHub: webhook ingress (issues / issue comments), replies as comments. */
export const GitHubProvider: ChannelProvider<GitHubCredentials, "github"> = {
  id: "github",
  ingest: "webhook",
  capabilities: { deliver: false, webhook: true },
  create(credentials, config, publish) {
    const surface = new GitHubAdapter(
      credentials.secret,
      config,
      publish,
      credentials.token,
      credentials.botUsername,
    );
    return {
      surface,
      webhookHandler: (request) => surface.handleWebhook(request),
    };
  },
};
