import {
  DiscordAdapter,
  GitHubAdapter,
  type ChannelDeliveryRoute,
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

export interface ChannelDrivers {
  readonly surfaces: Channel.Surface[];
  readonly deliveryRoutes: Map<string, ChannelDeliveryRoute>;
  readonly githubWebhookHandler?: (request: Request) => Promise<Response>;
}

export function createChannelDrivers(
  config: OpenOmniConfig,
  handler: Channel.MessageHandler,
  factories: ChannelFactories = defaultFactories,
): ChannelDrivers {
  const surfaces: Channel.Surface[] = [];
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  let githubWebhookHandler: ((request: Request) => Promise<Response>) | undefined;

  const telegramConfig = config.channels?.telegram;
  if (telegramConfig !== undefined) {
    const telegram = factories.telegram(telegramConfig.token, { triggers: [] });
    telegram.onMessage(handler);
    surfaces.push(telegram);
    deliveryRoutes.set(telegram.id, (externalId, body, idempotencyKey) =>
      telegram.deliver(externalId, body, idempotencyKey),
    );
  }

  const githubConfig = config.channels?.github;
  if (githubConfig !== undefined) {
    const github = factories.github(
      githubConfig.secret,
      { triggers: [{ type: "event", events: ["issue_comment.created", "issues.opened"] }] },
      githubConfig.token,
      githubConfig.botUsername,
    );
    github.onMessage(handler);
    surfaces.push(github);
    githubWebhookHandler = (request) => github.handleWebhook(request);
  }

  const discordConfig = config.channels?.discord;
  if (discordConfig !== undefined) {
    const discord = factories.discord(discordConfig.token, {
      triggers: [{ type: "mention" }],
    });
    discord.onMessage(handler);
    surfaces.push(discord);
    deliveryRoutes.set(discord.id, (externalId, body, idempotencyKey) =>
      discord.deliver(externalId, body, idempotencyKey),
    );
  }

  return {
    surfaces,
    deliveryRoutes,
    ...(githubWebhookHandler === undefined ? {} : { githubWebhookHandler }),
  };
}
