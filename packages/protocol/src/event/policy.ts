import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Policy, RuntimeResource } from "../policy/index.js";

const PolicyBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: z.number(),
});

const PolicyObligation = z
  .object({
    type: z.string(),
  })
  .passthrough();

const PolicyAuditContext = z.object({
  effects: Policy.PolicyEffect.array().optional(),
  obligations: PolicyObligation.array().optional(),
  reasonCodes: z.string().array().optional(),
  factsUsed: z.string().array().optional(),
  durationMs: z.number().optional(),
  pointId: z.string().optional(),
  pointVersion: z.number().optional(),
  resourceDescriptor: RuntimeResource.Descriptor.optional(),
});

const EffectiveVerdict = z.enum(["allow", "deny", "pending"]);

export namespace PolicyEvent {
  export const ActionRequested = BusEvent.define(
    "policy.action.requested",
    PolicyBase.extend({
      actionId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
  );

  export const Evaluated = BusEvent.define(
    "policy.evaluated",
    PolicyBase.extend({
      policyId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: z.enum(["continue", "skip", "abort", "retry", "transform", "inject"]),
      reason: z.string(),
      beforeSideEffect: z.record(z.string(), z.unknown()).optional(),
    }).merge(PolicyAuditContext),
  );

  export const DecisionComposed = BusEvent.define(
    "policy.decision.composed",
    PolicyBase.extend({
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: EffectiveVerdict,
      reason: z.string(),
    }).merge(PolicyAuditContext),
  );

  export const ActionBlocked = BusEvent.define(
    "policy.action.blocked",
    PolicyBase.extend({
      actionId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: z.enum(["continue", "skip", "abort", "retry", "transform", "inject"]),
      reason: z.string(),
    }),
  );

  export const ActionApproved = BusEvent.define(
    "policy.action.approved",
    PolicyBase.extend({
      actionId: z.string(),
      actor: z.record(z.string(), z.unknown()),
      action: z.string(),
      resource: z.string(),
      verdict: z.enum(["continue", "skip", "abort", "retry", "transform", "inject"]),
      reason: z.string(),
    }),
  );
}
