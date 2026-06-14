export type { ChannelAuthnDecisionObserver } from "./authn/types";

import { authenticateGitHubWebhook as authenticateGitHubWebhookImpl } from "./authn/github";
import {
  authenticateDiscordTriggers as authenticateDiscordTriggersImpl,
  authenticateGitHubTriggers as authenticateGitHubTriggersImpl,
  authenticateTelegramTriggers as authenticateTelegramTriggersImpl,
} from "./authn/triggers";
import { authenticateWebSocketUpgrade as authenticateWebSocketUpgradeImpl } from "./authn/websocket";

export namespace ChannelAuthnMiddleware {
  export const authenticateDiscordTriggers = authenticateDiscordTriggersImpl;
  export const authenticateTelegramTriggers = authenticateTelegramTriggersImpl;
  export const authenticateGitHubTriggers = authenticateGitHubTriggersImpl;
  export const authenticateWebSocketUpgrade = authenticateWebSocketUpgradeImpl;
  export const authenticateGitHubWebhook = authenticateGitHubWebhookImpl;
}
