import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
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
  capabilities: {
    deliver: false,
    webhook: true,
    // GitHub renders markdown natively and comments carry no driver-enforced limit.
    render: { renderMarkdown: (markdown: string) => markdown, messageLimit: null },
  },
  credentials: z
    .object({
      secret: z.string().min(1),
      token: z.string().min(1).optional(),
      botUsername: z.string().min(1).optional(),
    })
    .strict(),
  settings: z.record(z.string(), z.never()),
  preconditions: [
    "repository webhook posts issues/issue_comment events to the public endpoint with the shared secret",
  ],
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
