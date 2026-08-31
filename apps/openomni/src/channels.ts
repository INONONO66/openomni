/**
 * Channel profile — the declarative row list of external channel components.
 *
 * Each configured channel is one row: an id plus a build step that binds the
 * Resident's message handler and exposes the channel's seams (surface
 * lifecycle, outbound delivery route, webhook ingress). The profile is data —
 * boot mounts each row as its own composition stage, so what the app composes
 * is readable here in one place instead of scattered through boot control
 * flow, and disposing a stage revokes exactly that channel's listening,
 * deliverability, and trusted-channel authority.
 *
 * A row exists only for a configured channel. There is no disabled-row state
 * and no default credential — absence of config is absence of the component.
 */

import {
  type ChannelDeliveryRoute,
  DiscordAdapter,
  GitHubAdapter,
  TelegramAdapter,
} from "@openomni/channels";
import type { Channel } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { OpenOmniConfig } from "./config";

type DeliveringSurface = Channel.Surface & {
  deliver(
    externalId: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<{
    externalMessageId?: string;
  }>;
};

type GitHubSurface = Channel.Surface & {
  handleWebhook(request: Request): Promise<Response>;
};

interface ChannelFactories {
  readonly discord: (token: string, config: Channel.Config) => DeliveringSurface;
  readonly telegram: (token: string, config: Channel.Config) => DeliveringSurface;
  readonly github: (
    secret: string,
    config: Channel.Config,
    token?: string,
    botUsername?: string,
  ) => GitHubSurface;
}

const defaultFactories: ChannelFactories = {
  discord: (token, config) => new DiscordAdapter(token, config, Bus.publish),
  telegram: (token, config) => new TelegramAdapter(token, config, Bus.publish),
  github: (secret, config, token, botUsername) =>
    new GitHubAdapter(secret, config, Bus.publish, token, botUsername),
};

interface BuiltChannel {
  readonly surface: Channel.Surface;
  /** Outbound seam, keyed by `surface.id`: present only for channels the Resident can message into. */
  readonly deliveryRoute?: ChannelDeliveryRoute;
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

interface ChannelComponent {
  readonly id: "telegram" | "github" | "discord";
  /** Constructs the surface and binds the Resident handler. Called once per boot. */
  build(handler: Channel.MessageHandler): BuiltChannel;
}

function deliveringChannel(surface: DeliveringSurface): BuiltChannel {
  return {
    surface,
    deliveryRoute: (externalId, body, idempotencyKey) =>
      surface.deliver(externalId, body, idempotencyKey),
  };
}

/** One row per configured channel, in composition order. */
export function channelProfile(
  config: OpenOmniConfig,
  factories: ChannelFactories = defaultFactories,
): ChannelComponent[] {
  const rows: ChannelComponent[] = [];

  const telegramConfig = config.channels?.telegram;
  if (telegramConfig !== undefined) {
    rows.push({
      id: "telegram",
      build(handler) {
        const telegram = factories.telegram(telegramConfig.token, { triggers: [] });
        telegram.onMessage(handler);
        return deliveringChannel(telegram);
      },
    });
  }

  const githubConfig = config.channels?.github;
  if (githubConfig !== undefined) {
    rows.push({
      id: "github",
      build(handler) {
        const github = factories.github(
          githubConfig.secret,
          { triggers: [{ type: "event", events: ["issue_comment.created", "issues.opened"] }] },
          githubConfig.token,
          githubConfig.botUsername,
        );
        github.onMessage(handler);
        return { surface: github, webhookHandler: (request) => github.handleWebhook(request) };
      },
    });
  }

  const discordConfig = config.channels?.discord;
  if (discordConfig !== undefined) {
    rows.push({
      id: "discord",
      build(handler) {
        const discord = factories.discord(discordConfig.token, {
          triggers: [{ type: "mention" }],
        });
        discord.onMessage(handler);
        return deliveringChannel(discord);
      },
    });
  }

  return rows;
}
