import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";
// Deep imports (not ../policy/index.js): the Policy namespace re-exports these
// descriptors as `Policy.Events`, so importing the barrel here would be a cycle.
import { PolicyEffects } from "../policy/effects.js";
import { PolicyResource } from "../policy/resource.js";

const PolicyBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: EpochMs,
});

// Audit events retain upcast-on-read compatibility with historical obligations
// that only guaranteed a free-form `type`. PolicyEffects.PolicyObligation is
// the canonical owner; this derived shape keeps its fields optional and
// preserves unknown fields. Acceptance is slightly NARROWER than the old
// independent passthrough: canonical-owner keys (obligationId, description,
// timeoutMs, resolvedBy) are now validated when present, so a payload carrying
// one with a nonconforming value is rejected instead of passed through. The
// sole producer (policy engine audit) already conforms, and no read path
// re-parses persisted rows with this schema.
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

// Single owner of the subject a policy decision is ABOUT. All four decision
// events name the same triple; only the identity slot (actionId / policyId /
// none) and the audit context differ, so those stay per-descriptor below.
// This is a local base+extend inside ONE event family, which the audit's
// do-not-touch ledger permits — it is deliberately NOT a universal BaseEvent,
// because correlation requirements differ across families.
const PolicySubject = {
  actor: z.record(z.string(), z.unknown()),
  action: z.string(),
  resource: z.string(),
} as const;

// Single owner of the decision itself. `EffectiveVerdict` is the same three
// literals every verdict-bearing event admits; reason is free-form prose.
const PolicyDecision = {
  ...PolicySubject,
  verdict: EffectiveVerdict,
  reason: z.string(),
} as const;

export const Events = {
  ActionRequested: BusEvent.define(
    "policy.action.requested",
    PolicyBase.extend({
      actionId: z.string(),
      ...PolicySubject,
      context: z.record(z.string(), z.unknown()).optional(),
    }),
    { visibility: "ephemeral" },
  ),
  Evaluated: BusEvent.define(
    "policy.evaluated",
    PolicyBase.extend({
      policyId: z.string(),
      ...PolicyDecision,
      beforeSideEffect: z.record(z.string(), z.unknown()).optional(),
    }).merge(PolicyAuditContext),
    { visibility: "llm_reason" },
  ),
  DecisionComposed: BusEvent.define(
    "policy.decision.composed",
    // No per-action or per-policy id: this event reports the COMPOSED verdict
    // for a point, not one policy's evaluation.
    PolicyBase.extend(PolicyDecision).merge(PolicyAuditContext),
    { visibility: "llm_reason" },
  ),
  ActionBlocked: BusEvent.define(
    "policy.action.blocked",
    // Deliberately NOT merged with PolicyAuditContext: the block record is the
    // perimeter refusal, not the audit trail that produced it.
    PolicyBase.extend({ actionId: z.string(), ...PolicyDecision }),
    { visibility: "llm_reason" },
  ),
};
