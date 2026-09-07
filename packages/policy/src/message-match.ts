import type { Actor, Gateway, LedgerSession } from "@openomni/protocol";

/** Authenticated projections supplied by the gateway's execution owner. */
export type MessagePolicyContext =
  | {
      readonly sender: "external";
      readonly senderTier?: Actor.TrustTier;
      readonly addressee: "bot" | "owner" | "ambient";
      readonly identity: boolean;
      readonly grantTier: boolean;
      readonly egressBudget: boolean;
      readonly eventIdUnique: boolean;
      readonly replyCorrelation: boolean;
    }
  | {
      readonly sender: "session";
      readonly senderRole: LedgerSession.Role;
      readonly targetKind: Gateway.SendMessage["to"]["kind"];
      readonly targetRole?: LedgerSession.Role;
      readonly type: Gateway.SendMessage["type"];
      readonly parentChild: boolean;
      readonly fanout: number;
      readonly depth: number;
      readonly withinParentDeadline: boolean;
      readonly actorSendAllowed?: boolean;
    };

export function matchesMessage(
  rule: Gateway.RuleTableA | Gateway.RuleTableB,
  context: MessagePolicyContext | undefined,
): boolean {
  if (context === undefined) return false;
  switch (rule.table) {
    case "A": {
      if (context.sender !== "external") return false;
      if (rule.senderTier !== undefined && rule.senderTier !== context.senderTier) return false;
      if (rule.addressee !== undefined && rule.addressee !== context.addressee) return false;
      const checks = {
        identity: context.identity,
        grant_tier: context.grantTier,
        egress_budget: context.egressBudget,
        event_id_dedupe: context.eventIdUnique,
        reply_correlation: context.replyCorrelation,
      };
      return checks[rule.check] === (rule.effect === "allow");
    }
    case "B": {
      if (context.sender !== "session" || rule.senderRole !== context.senderRole) return false;
      if (rule.targetKind !== undefined && rule.targetKind !== context.targetKind) return false;
      if (rule.targetRole !== undefined && rule.targetRole !== context.targetRole) return false;
      if (rule.type !== undefined && rule.type !== context.type) return false;
      let valid: boolean;
      switch (rule.check.kind) {
        case "parent_child":
          valid = context.parentChild;
          break;
        case "fanout":
          valid = context.fanout < rule.check.max;
          break;
        case "depth":
          valid = context.depth <= rule.check.max;
          break;
        case "deadline":
          valid = context.withinParentDeadline;
          break;
        case "actor_send":
          valid = context.actorSendAllowed === true;
          break;
        case "type":
          return true;
        default:
          return exhaustive(rule.check);
      }
      return valid === (rule.effect === "allow");
    }
    default:
      return exhaustive(rule);
  }
}

function exhaustive(value: never): never {
  throw new TypeError(`Invalid message policy variant: ${String(value)}`);
}
