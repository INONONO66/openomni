export type { ChannelAuthnDecisionObserver } from "./authn/types";

import {
  DiscordTriggers as DiscordTriggersDefinition,
  GitHubHmac as GitHubHmacDefinition,
  GitHubTriggers as GitHubTriggersDefinition,
  TelegramTriggers as TelegramTriggersDefinition,
  WebSocketToken as WebSocketTokenDefinition,
} from "./authn/definitions";
import { authenticateGitHubWebhook as authenticateGitHubWebhookImpl } from "./authn/github";
import {
  authenticateDiscordTriggers as authenticateDiscordTriggersImpl,
  authenticateGitHubTriggers as authenticateGitHubTriggersImpl,
  authenticateTelegramTriggers as authenticateTelegramTriggersImpl,
} from "./authn/triggers";
import { authenticateWebSocketUpgrade as authenticateWebSocketUpgradeImpl } from "./authn/websocket";

export namespace ChannelAuthnMiddleware {
  export const WebSocketToken = WebSocketTokenDefinition;
  export const GitHubHmac = GitHubHmacDefinition;
  export const DiscordTriggers = DiscordTriggersDefinition;
  export const TelegramTriggers = TelegramTriggersDefinition;
  export const GitHubTriggers = GitHubTriggersDefinition;

  export const authenticateDiscordTriggers = authenticateDiscordTriggersImpl;
  export const authenticateTelegramTriggers = authenticateTelegramTriggersImpl;
  export const authenticateGitHubTriggers = authenticateGitHubTriggersImpl;
  export const authenticateWebSocketUpgrade = authenticateWebSocketUpgradeImpl;
  export const authenticateGitHubWebhook = authenticateGitHubWebhookImpl;
}
