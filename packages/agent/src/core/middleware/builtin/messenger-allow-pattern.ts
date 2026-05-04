import { Guardrail, type Messenger } from "@openomni/protocol";
import type { MiddlewareRegistration } from "../types";

export interface MessengerAllowPatternConfig {
  allowPatterns?: Messenger.AllowPattern[];
}

function matchesPattern(pattern: Messenger.AllowPattern, from: string, to: string): boolean {
  const fromMatch = pattern.from === "*" || pattern.from === from;
  const toMatch = pattern.to === "*" || pattern.to === to;
  return fromMatch && toMatch;
}

function evaluateMessengerPermission(input: {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
}) {
  const action = "messenger.envelope.send";
  const resource = `${input.fromAgentId}->${input.toAgentId}`;
  return Guardrail.evaluate(
    {
      action,
      inputRules: [
        {
          toolPattern: resource,
          field: "allowed",
          pattern: "^true$",
          action: "allow",
          reason: input.allowReason,
          priority: 2,
        },
        {
          toolPattern: resource,
          field: "allowed",
          pattern: "^false$",
          action: "deny",
          reason: input.denyReason,
          priority: 1,
        },
      ],
    },
    {
      action,
      resource,
      actor: { agentId: input.fromAgentId },
      input: { allowed: String(input.allowed), toAgentId: input.toAgentId },
    },
  );
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
        return Guardrail.evaluate(undefined, {
          action: "messenger.envelope.send",
          resource: "messenger.envelope",
        });
      }

      const { allowPatterns } = config;

      if (!allowPatterns || allowPatterns.length === 0) {
        return evaluateMessengerPermission({
          fromAgentId,
          toAgentId,
          allowed: true,
          allowReason: "no_allow_patterns_configured",
          denyReason: `authorization denied: ${fromAgentId} → ${toAgentId}`,
        });
      }

      const isAuthorized = allowPatterns.some((p) => matchesPattern(p, fromAgentId, toAgentId));

      if (isAuthorized) {
        return evaluateMessengerPermission({
          fromAgentId,
          toAgentId,
          allowed: true,
          allowReason: "allow_pattern_matched",
          denyReason: `authorization denied: ${fromAgentId} → ${toAgentId}`,
        });
      }

      return evaluateMessengerPermission({
        fromAgentId,
        toAgentId,
        allowed: false,
        allowReason: "allow_pattern_matched",
        denyReason: `authorization denied: ${fromAgentId} → ${toAgentId}`,
      });
    },
  };
}
