import { z } from "zod";
import { BusEvent } from "../bus/index.js";
// Deep imports (not ../policy/index.js): the Policy namespace re-exports these
// descriptors as `Policy.Events`, so importing the barrel here would be a cycle.
import { PolicyEffects } from "../policy/effects.js";
import { PolicyResource } from "../policy/resource.js";

const PolicyBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: z.number(),
});

// Audit events retain upcast-on-read compatibility with historical obligations
// that only guaranteed a free-form `type`. PolicyEffects.PolicyObligation is
// the canonical owner; this derived shape keeps its fields optional and
// preserves unknown fields without changing the event wire meaning.
const PolicyObligation = PolicyEffects.PolicyObligation.partial()
  .extend({ type: z.string() })
  .passthrough();

const PolicyAuditContext = z.object({
  effects: PolicyEffects.PolicyEffect.array().optional(),
  obligations: PolicyObligation.array().optional(),
  reasonCodes: z.string().array().optional(),
  factsUsed: z.string().array().optional(),
  durationMs: z.number().optional(),
  pointId: z.string().optional(),
  pointVersion: z.number().optional(),
  resourceDescriptor: PolicyResource.Descriptor.optional(),
});

const EffectiveVerdict = z.enum(["allow", "deny", "pending"]);

export const Events = {
  ActionRequested: BusEvent.define(
    "policy.action.requested",
    PolicyBase.extend({
      actionId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
    { visibility: "ephemeral" },
  ),
  Evaluated: BusEvent.define(
    "policy.evaluated",
    PolicyBase.extend({
      policyId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: z.enum(["allow", "deny", "pending"]),
      reason: z.string(),
      beforeSideEffect: z.record(z.string(), z.unknown()).optional(),
    }).merge(PolicyAuditContext),
    { visibility: "llm_reason" },
  ),
  DecisionComposed: BusEvent.define(
    "policy.decision.composed",
    PolicyBase.extend({
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: EffectiveVerdict,
      reason: z.string(),
    }).merge(PolicyAuditContext),
    { visibility: "llm_reason" },
  ),
  ActionBlocked: BusEvent.define(
    "policy.action.blocked",
    PolicyBase.extend({
      actionId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: z.enum(["allow", "deny", "pending"]),
      reason: z.string(),
    }),
    { visibility: "llm_reason" },
  ),
};
