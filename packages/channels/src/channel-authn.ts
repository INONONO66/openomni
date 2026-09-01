export type { ChannelAuthnDecisionObserver } from "./authn/types";

import { authenticateGitHubWebhook } from "./authn/github";
import {
  authenticateDiscordTriggers,
  authenticateGitHubTriggers,
  authenticateSlackTriggers,
  authenticateTelegramTriggers,
} from "./authn/triggers";
import { authenticateWebSocketUpgrade } from "./authn/websocket";

export const ChannelAuthnMiddleware = {
  authenticateDiscordTriggers,
  authenticateTelegramTriggers,
  authenticateSlackTriggers,
  authenticateGitHubTriggers,
  authenticateWebSocketUpgrade,
  authenticateGitHubWebhook,
};
