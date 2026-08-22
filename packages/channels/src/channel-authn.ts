export type { ChannelAuthnDecisionObserver } from "./authn/types";

import { authenticateGitHubWebhook } from "./authn/github";
import {
  authenticateDiscordTriggers,
  authenticateGitHubTriggers,
  authenticateTelegramTriggers,
} from "./authn/triggers";
import { authenticateWebSocketUpgrade } from "./authn/websocket";

export const ChannelAuthnMiddleware = {
  authenticateDiscordTriggers,
  authenticateTelegramTriggers,
  authenticateGitHubTriggers,
  authenticateWebSocketUpgrade,
  authenticateGitHubWebhook,
};
