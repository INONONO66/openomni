import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const PolicyBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: z.number(),
});

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
    }),
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
