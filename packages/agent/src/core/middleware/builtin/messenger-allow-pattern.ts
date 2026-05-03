import type { Messenger } from "@openomni/protocol";
import type { MiddlewareRegistration } from "../types";

export interface MessengerAllowPatternConfig {
  allowPatterns?: Messenger.AllowPattern[];
}

function matchesPattern(pattern: Messenger.AllowPattern, from: string, to: string): boolean {
  const fromMatch = pattern.from === "*" || pattern.from === from;
  const toMatch = pattern.to === "*" || pattern.to === to;
  return fromMatch && toMatch;
}

export function createMessengerAllowPatternMiddleware(
  config: MessengerAllowPatternConfig,
): MiddlewareRegistration {
  return {
    name: "builtin:messenger-allow-pattern",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const fromAgentId = ctx.envelope?.fromAgentId;
      const toAgentId = ctx.envelope?.toAgentId;

      if (!fromAgentId || !toAgentId) {
        return {
          action: "continue",
          reason: "no_envelope",
          policyId: "messenger.allow-pattern",
        };
      }

      const { allowPatterns } = config;

      if (!allowPatterns || allowPatterns.length === 0) {
        return {
          action: "continue",
          reason: "no_allow_patterns_configured",
          policyId: "messenger.allow-pattern",
        };
      }

      const isAuthorized = allowPatterns.some((p) => matchesPattern(p, fromAgentId, toAgentId));

      if (isAuthorized) {
        return {
          action: "continue",
          reason: "allow_pattern_matched",
          policyId: "messenger.allow-pattern",
        };
      }

      return {
        action: "abort",
        reason: `authorization denied: ${fromAgentId} → ${toAgentId}`,
        policyId: "messenger.allow-pattern",
      };
    },
  };
}
