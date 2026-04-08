import type { Adapter } from "@openomni/protocol";

export function evaluateTriggers(
  rules: Adapter.TriggerRule[],
  ctx: Adapter.TriggerContext,
): boolean {
  if (rules.length === 0) return true;
  return rules.every((rule) => evaluateRule(rule, ctx));
}

function evaluateRule(rule: Adapter.TriggerRule, ctx: Adapter.TriggerContext): boolean {
  switch (rule.type) {
    case "event":
      return rule.events.includes(ctx.event);

    case "mention":
      // DMs always pass the mention check
      return ctx.isDM === true || ctx.mentioned;

    case "prefix":
      return ctx.text.startsWith(rule.value);

    case "label":
      if (!ctx.labels || ctx.labels.length === 0) return false;
      return rule.values.some((v) => ctx.labels!.includes(v));

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

export function stripTriggerPrefix(text: string, rules: Adapter.TriggerRule[]): string {
  const prefix = rules.find(
    (r): r is Extract<Adapter.TriggerRule, { type: "prefix" }> => r.type === "prefix",
  );
  if (prefix) {
    return text.slice(prefix.value.length).trim();
  }
  return text;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeContent(
  text: string,
  rules: Adapter.TriggerRule[],
  botUsername?: string,
): string {
  let result = stripTriggerPrefix(text, rules);
  if (botUsername) {
    result = result.replace(new RegExp(`@${escapeRegex(botUsername)}\\s*`, "g"), "").trim();
  }
  return result;
}
