import type { Adapter } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter, WebSocketHandler } from "../channel";
import type { PublishPort } from "../channel/types";
import type { ServerConfig } from "../config";
import type { ChannelDeliveryRoute } from "./messaging";

type Surface = {
  start(traceId: string): Promise<void> | void;
  stop(traceId: string): void;
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
  // Composition-root binding: channel adapters observe through an injected
  // publish port; today it is the session Bus (same seam as the execution
  // coordinator's events.publish, #462 §2).
  const publish: PublishPort = Bus.publish;

  if (routingHandler) {
    wsHandler = new WebSocketHandler(routingHandler, publish, { token: config.server.wsToken });
  }

  if (config.telegram.token && routingHandler) {
    const telegram = new TelegramAdapter(
      config.telegram.token,
      {
        triggers: [
          ...(config.telegram.allowedUsers.length > 0
            ? [{ type: "sender" as const, allow: config.telegram.allowedUsers }]
            : []),
        ],
      },
      publish,
    );
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
      },
      publish,
      config.github.token,
      config.github.botUsername,
    );
    github.onMessage(routingHandler);
    githubWebhookHandler = (req) => github.handleWebhook(req);
    channels.push(github);
  }

  if (config.discord.token && routingHandler) {
    const discord = new DiscordAdapter(
      config.discord.token,
      {
        triggers: [
          { type: "mention" },
          ...(config.discord.allowedUsers.length > 0
            ? [{ type: "sender" as const, allow: config.discord.allowedUsers }]
            : []),
        ],
      },
      publish,
    );
    discord.onMessage(routingHandler);
    channels.push(discord);
    deliveryRoutes.set(discord.id, (externalId, body) => discord.deliver(externalId, body));
  }

  return { channels, wsHandler, githubWebhookHandler, deliveryRoutes };
}
