import type { Adapter } from "@openomni/protocol";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter, WebSocketHandler } from "../channel";
import type { ServerConfig } from "../config";
import type { ChannelDeliveryRoute } from "./messaging";

type Surface = {
  start(): Promise<void> | void;
  stop(): void;
};

export interface ChannelSetup {
  channels: Surface[];
  wsHandler: WebSocketHandler | undefined;
  githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;
  /**
   * Existing-agent delivery routes, keyed by ActorEndpoint channel: the
   * concrete owners behind the messaging kernel's injected-delivery seam.
   * Only channels whose surface can address an endpoint's externalId and
   * report a platform message id register here (Discord DM, Telegram chat);
   * GitHub comments need an issue context an ActorEndpoint does not carry.
   */
  deliveryRoutes: Map<string, ChannelDeliveryRoute>;
}

export function createChannelAdapters(
  config: ServerConfig,
  routingHandler: Adapter.MessageHandler | undefined,
): ChannelSetup {
  const channels: Surface[] = [];
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  let wsHandler: WebSocketHandler | undefined;
  let githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;

  if (routingHandler) {
    wsHandler = new WebSocketHandler(routingHandler, { token: config.server.wsToken });
  }

  if (config.telegram.token && routingHandler) {
    const telegram = new TelegramAdapter(config.telegram.token, {
      triggers: [
        ...(config.telegram.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.telegram.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    telegram.onMessage(routingHandler);
    channels.push(telegram);
    deliveryRoutes.set(telegram.id, (externalId, body) => telegram.deliver(externalId, body));
  }

  if (config.github.secret && routingHandler) {
    const github = new GitHubAdapter(
      config.github.secret,
      {
        triggers: [
          { type: "event", events: ["issue_comment.created", "issues.opened"] },
          ...(config.github.allowedUsers.length > 0
            ? [{ type: "sender" as const, allow: config.github.allowedUsers }]
            : []),
        ],
        deliveryPolicy: "final",
      },
      config.github.token,
      config.github.botUsername,
    );
    github.onMessage(routingHandler);
    githubWebhookHandler = (req) => github.handleWebhook(req);
    channels.push(github);
  }

  if (config.discord.token && routingHandler) {
    const discord = new DiscordAdapter(config.discord.token, {
      triggers: [
        { type: "mention" },
        ...(config.discord.allowedUsers.length > 0
          ? [{ type: "sender" as const, allow: config.discord.allowedUsers }]
          : []),
      ],
      deliveryPolicy: "final",
    });
    discord.onMessage(routingHandler);
    channels.push(discord);
    deliveryRoutes.set(discord.id, (externalId, body) => discord.deliver(externalId, body));
  }

  return { channels, wsHandler, githubWebhookHandler, deliveryRoutes };
}
