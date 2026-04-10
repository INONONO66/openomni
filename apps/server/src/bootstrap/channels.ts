import type { Adapter } from "@openomni/protocol";
import { DiscordAdapter, GitHubAdapter, TelegramAdapter, WebSocketHandler } from "../channel";
import type { ServerConfig } from "../config";

type Surface = {
  start(): Promise<void> | void;
  stop(): void;
};

export interface ChannelSetup {
  channels: Surface[];
  wsHandler: WebSocketHandler | undefined;
  githubWebhookHandler: ((req: Request) => Promise<Response>) | undefined;
}

export function createChannelAdapters(
  config: ServerConfig,
  routingHandler: Adapter.MessageHandler | undefined,
): ChannelSetup {
  const channels: Surface[] = [];
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
  }

  return { channels, wsHandler, githubWebhookHandler };
}
