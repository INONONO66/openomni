import type { Channel, Policy } from "@openomni/protocol";
import { evaluateTriggers } from "../support/trigger";
import { DiscordTriggers, GitHubTriggers, TelegramTriggers } from "./definitions";
import { evaluateChannelPermission, recordDecision } from "./decision";
import type {
  ChannelAuthnDecisionObserver,
  ChannelAuthnPolicyId,
  ChannelTriggerAuthInput,
  ChannelTriggerAuthResult,
} from "./types";

function triggerMetadata(input: {
  readonly surface: string;
  readonly rules: Channel.TriggerRule[];
  readonly ctx: Channel.TriggerContext;
}): Record<string, unknown> {
  return {
    surface: input.surface,
    event: input.ctx.event,
    channelId: input.ctx.channelId,
    senderId: input.ctx.senderId,
    mentioned: input.ctx.mentioned,
    isDM: input.ctx.isDM ?? false,
    labels: input.ctx.labels ?? [],
    triggerRuleCount: input.rules.length,
  };
}

function evaluateChannelTriggers(input: {
  readonly definition: Policy.Definition;
  readonly policyId: ChannelAuthnPolicyId;
  readonly surface: string;
  readonly resource: string;
  readonly rules: Channel.TriggerRule[];
  readonly ctx: Channel.TriggerContext;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): ChannelTriggerAuthResult {
  const startedAt = Date.now();
  const metadata = triggerMetadata({ surface: input.surface, rules: input.rules, ctx: input.ctx });
  const verdict = evaluateChannelPermission({
    action: input.policyId,
    resource: input.resource,
    field: "triggered",
    allowed: evaluateTriggers(input.rules, input.ctx),
    allowReason: `${input.surface} trigger accepted`,
    denyReason: `${input.surface} trigger denied`,
    metadata,
  });
  void recordDecision(
    input.definition,
    verdict,
    Date.now() - startedAt,
    input.onDecision,
    metadata,
  );

  return { verdict };
}

export function authenticateDiscordTriggers(
  input: ChannelTriggerAuthInput,
): ChannelTriggerAuthResult {
  return evaluateChannelTriggers({
    definition: DiscordTriggers,
    policyId: "channel.authn.discord-triggers",
    surface: "discord",
    resource: "discord.message",
    rules: input.triggers,
    ctx: input.ctx,
    ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
  });
}

export function authenticateTelegramTriggers(
  input: ChannelTriggerAuthInput,
): ChannelTriggerAuthResult {
  return evaluateChannelTriggers({
    definition: TelegramTriggers,
    policyId: "channel.authn.telegram-triggers",
    surface: "telegram",
    resource: "telegram.message",
    rules: input.triggers,
    ctx: input.ctx,
    ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
  });
}

export function authenticateGitHubTriggers(
  input: ChannelTriggerAuthInput,
): ChannelTriggerAuthResult {
  return evaluateChannelTriggers({
    definition: GitHubTriggers,
    policyId: "channel.authn.github-triggers",
    surface: "github",
    resource: `github.${input.ctx.event}`,
    rules: input.triggers,
    ctx: input.ctx,
    ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
  });
}
