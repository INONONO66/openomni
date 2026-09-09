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
    case "A": return matchesExternal(rule, context);
    case "B": return matchesSession(rule, context);
    default: return exhaustive(rule);
  }
}

function matchesExternal(
  rule: Gateway.RuleTableA,
  context: MessagePolicyContext,
): boolean {
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

function matchesSession(
  rule: Gateway.RuleTableB,
  context: MessagePolicyContext,
): boolean {
  if (context.sender !== "session" || rule.senderRole !== context.senderRole) return false;
  if (rule.targetKind !== undefined && rule.targetKind !== context.targetKind) return false;
  if (rule.targetRole !== undefined && rule.targetRole !== context.targetRole) return false;
  if (rule.type !== undefined && rule.type !== context.type) return false;
  if (rule.check.kind === "type") return true;
  return sessionCheck(rule.check, context) === (rule.effect === "allow");
}

function sessionCheck(
  check: Exclude<Gateway.RuleTableB["check"], { kind: "type" }>,
  context: Extract<MessagePolicyContext, { sender: "session" }>,
): boolean {
  switch (check.kind) {
    case "parent_child": return context.parentChild;
    case "fanout": return context.fanout < check.max;
    case "depth": return context.depth <= check.max;
    case "deadline": return context.withinParentDeadline;
    case "actor_send": return context.actorSendAllowed === true;
    default: return exhaustive(check);
  }
}

function exhaustive(value: never): never {
  throw new TypeError(`Invalid message policy variant: ${String(value)}`);
}
