import type { EventEnvelope } from "./envelope";

export interface RouterRule {
  id: string;
  match: {
    name?: string;
    sourceType?: string;
    tags?: string[];
    workspaceId?: string;
    userId?: string;
  };
  action: "trigger_task" | "agent" | "notify" | "ignore" | "escalate";
  target?: { taskId?: string; agentId?: string; fanout?: string[] };
  policyId?: string;
}

export interface RoutingDecision {
  ruleId?: string;
  action: RouterRule["action"];
  targets: string[];
  reason: string;
}

/**
 * Router namespace for managing event-to-task routing
 */
export namespace Router {
  const rules: RouterRule[] = [];

  function matchesRule(rule: RouterRule, envelope: EventEnvelope): boolean {
    const match = rule.match;

    if (match.name && match.name !== envelope.name) {
      return false;
    }

    if (match.sourceType && match.sourceType !== envelope.source.type) {
      return false;
    }

    if (match.workspaceId && match.workspaceId !== envelope.workspaceId) {
      return false;
    }

    if (match.userId && match.userId !== envelope.userId) {
      return false;
    }

    if (match.tags && match.tags.length > 0) {
      const envelopeTags = Array.isArray(envelope.meta?.tags)
        ? (envelope.meta.tags as unknown[]).filter(
            (tag): tag is string => typeof tag === "string",
          )
        : [];

      if (!match.tags.every((tag) => envelopeTags.includes(tag))) {
        return false;
      }
    }

    return true;
  }

  function targetsForRule(rule: RouterRule): string[] {
    const fanout = rule.target?.fanout ?? [];
    if (fanout.length > 0) {
      return [...fanout];
    }

    if (rule.action === "trigger_task" && rule.target?.taskId) {
      return [rule.target.taskId];
    }

    if (rule.action === "agent" && rule.target?.agentId) {
      return [rule.target.agentId];
    }

    return [];
  }

  /**
   * Register a routing rule
   */
  export function register(rule: RouterRule): void {
    rules.push(rule);
  }

  /**
   * Unregister a specific routing rule
   */
  export function unregister(ruleId: string): void {
    const index = rules.findIndex((r) => r.id === ruleId);
    if (index !== -1) {
      rules.splice(index, 1);
    }
  }

  /**
   * Route an event to a single routing decision
   */
  export function route(envelope: EventEnvelope): RoutingDecision {
    const matchedRule = rules.find((rule) => matchesRule(rule, envelope));

    if (!matchedRule) {
      return {
        action: "ignore",
        targets: [],
        reason: "No matching routing rule",
      };
    }

    return {
      ruleId: matchedRule.id,
      action: matchedRule.action,
      targets: targetsForRule(matchedRule),
      reason: `Matched rule ${matchedRule.id}`,
    };
  }

  /**
   * Compatibility helper for older call sites that expect task target arrays.
   */
  export function routeTargets(envelope: EventEnvelope): string[] {
    const decision = route(envelope);
    return decision.targets;
  }

  /**
   * Clear all routing rules
   */
  export function clear(): void {
    rules.length = 0;
  }
}
