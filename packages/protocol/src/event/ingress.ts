import { z } from "zod";
import { Actor } from "../actor/index.js";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
});

const RoutingDecisionBase = Base.extend({
  inboundId: z.string(),
  surface: z.string(),
  mode: z.enum(["direct", "internal"]),
  reason: z.string(),
  factsUsed: z.array(z.string()),
  target: z.string().optional(),
  sessionId: z.string().optional(),
  actorId: z.string().optional(),
  trustTier: Actor.TrustTier.optional(),
  inboundTreatment: Actor.InboundTreatment.optional(),
});

const RoutingDecisionPayloadSchema = z.union([
  RoutingDecisionBase.extend({
    stage: z.literal("blacklist"),
    outcome: z.literal("drop"),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("wait_correlation"),
    outcome: z.literal("route"),
    target: z.string(),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("wait_correlation"),
    outcome: z.literal("ambiguous"),
    candidateInteractionIds: z.array(z.string().regex(/^wait:.+/)).min(2),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("wait_correlation"),
    outcome: z.literal("block"),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("channel_ceiling"),
    outcome: z.literal("block"),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("actor_identity"),
    outcome: z.literal("block"),
  }).strict(),
  RoutingDecisionBase.extend({
    stage: z.literal("surface_default"),
    outcome: z.literal("route"),
    target: z.string(),
  }).strict(),
]);

export type RoutingDecisionPayload = z.infer<typeof RoutingDecisionPayloadSchema>;

export const Events = {
  RoutingDecision: BusEvent.define("ingress.routing.decision", RoutingDecisionPayloadSchema, {
    visibility: "user_audit",
  }),
};
