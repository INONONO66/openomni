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

function routingDecisionUnion(candidateId: z.ZodType<string>) {
  return z.union([
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
      candidateInteractionIds: z.array(candidateId).min(2),
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
}

const RoutingDecisionPayloadSchema = routingDecisionUnion(z.string().regex(/^wait:.+/));

export type RoutingDecisionPayload = z.infer<typeof RoutingDecisionPayloadSchema>;

// Upcast-on-read for persisted `route.decided` bytes: facts recorded before
// the pending-stack deletion carry optional `runId`/`pendingInteractionId`
// fields and may list `pending_ask:*`/`pending_interaction:*` wait candidates
// on `ambiguous` rows. The reader strips the two dead fields and reads legacy
// candidate ids verbatim (ambiguous rows never route and never grant, so the
// wider vocabulary is comparison-only). Anything that still fails the union
// was never a valid route.decided of any era — the caller decides how that
// fails closed. New writes go through RoutingDecisionPayloadSchema and cannot
// produce these legacy shapes.
const RecordedRoutingDecisionSchema = routingDecisionUnion(
  z.string().regex(/^(?:wait|pending_ask|pending_interaction):.+/),
);

export function recordedRoutingDecision(data: unknown): RoutingDecisionPayload | undefined {
  const upcast =
    typeof data === "object" && data !== null
      ? (() => {
          const {
            runId: _runId,
            pendingInteractionId: _pendingInteractionId,
            ...rest
          } = data as Record<string, unknown>;
          return rest;
        })()
      : data;
  const result = RecordedRoutingDecisionSchema.safeParse(upcast);
  return result.success ? result.data : undefined;
}

export const Events = {
  RoutingDecision: BusEvent.define("ingress.routing.decision", RoutingDecisionPayloadSchema, {
    visibility: "user_audit",
  }),
};
