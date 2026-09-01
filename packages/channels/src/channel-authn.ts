export type { ChannelAuthnDecisionObserver } from "./authn/types";

import { authenticateGitHubWebhook } from "./authn/github";
import type { ChannelAuthnDecisionObserver } from "./authn/types";
import {
  authenticateDiscordTriggers,
  authenticateGitHubTriggers,
  authenticateSlackTriggers,
  authenticateTelegramTriggers,
} from "./authn/triggers";
import { authenticateWebSocketUpgrade } from "./authn/websocket";

/**
 * Optional-observer spread for exactOptionalPropertyTypes: an absent observer
 * must contribute NO `onDecision` key, not an undefined one.
 */
export function decisionOption(
  onDecision: ChannelAuthnDecisionObserver | undefined,
): { onDecision?: ChannelAuthnDecisionObserver } {
  return onDecision === undefined ? {} : { onDecision };
}

export const ChannelAuthnMiddleware = {
  authenticateDiscordTriggers,
  authenticateTelegramTriggers,
  authenticateSlackTriggers,
  authenticateGitHubTriggers,
  authenticateWebSocketUpgrade,
  authenticateGitHubWebhook,
};
