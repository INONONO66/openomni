import type { Channel } from "@openomni/protocol";

export function evaluateTriggers(
  rules: Channel.TriggerRule[],
  ctx: Channel.TriggerContext,
): boolean {
  if (rules.length === 0) return true;
  return rules.every((rule) => evaluateRule(rule, ctx));
}

function evaluateRule(rule: Channel.TriggerRule, ctx: Channel.TriggerContext): boolean {
  switch (rule.type) {
    case "event":
      return rule.events.includes(ctx.event);

    case "mention":
      // DMs always pass the mention check
      return ctx.isDM === true || ctx.mentioned;

    case "prefix":
      return ctx.text.startsWith(rule.value);

    case "label": {
      const labels = ctx.labels;
      if (!labels || labels.length === 0) return false;
      return rule.values.some((v) => labels.includes(v));
    }

    case "channel":
      if (!ctx.channelId) return ctx.isDM === true;
      return rule.ids.includes(ctx.channelId);

    case "sender":
      if (rule.deny?.includes(ctx.senderId)) return false;
      if (rule.allow && rule.allow.length > 0) {
        return rule.allow.includes(ctx.senderId);
      }
      return true;
  }
}

function stripTriggerPrefix(text: string, rules: Channel.TriggerRule[]): string {
  const prefix = rules.find(
    (r): r is Extract<Channel.TriggerRule, { type: "prefix" }> => r.type === "prefix",
  );
  // Only strip when the text actually starts with the prefix — a message
  // admitted by another trigger (mention, label) must not lose its head.
  if (prefix && text.startsWith(prefix.value)) {
    return text.slice(prefix.value.length).trim();
  }
  return text;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeContent(
  text: string,
  rules: Channel.TriggerRule[],
  botUsername?: string,
): string {
  let result = stripTriggerPrefix(text, rules);
  if (botUsername) {
    result = result.replace(new RegExp(`@${escapeRegex(botUsername)}\\s*`, "g"), "").trim();
  }
  return result;
}
