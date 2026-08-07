import { z } from "zod";
import { Actor } from "../actor/index.js";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
});

// Canonical target labels: "resident", "resident:<sessionId>", "worker", "worker:<id>", "worker-session:<id>"
const IngressTargetLabel = z.string().optional();

const RoutingDecisionBase = Base.extend({
  inboundId: z.string(),
  surface: z.string(),
  mode: z.enum(["direct", "internal"]),
  reason: z.string(),
  factsUsed: z.array(z.string()),
  target: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  pendingInteractionId: z.string().optional(),
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
    candidateInteractionIds: z
      .array(z.string().regex(/^(?:wait|pending_ask|pending_interaction):.+/))
      .min(2),
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

export namespace IngressEvent {
  export const RoutingDecision = BusEvent.define(
    "ingress.routing.decision",
    RoutingDecisionPayloadSchema,
    { visibility: "user_audit" },
  );

  export const Received = BusEvent.define(
    "ingress.received",
    Base.extend({
      surface: z.string(),
      mode: z.enum(["plan", "direct", "internal"]),
      target: IngressTargetLabel,
      payloadLength: z.number(),
    }),
    { visibility: "user_audit" },
  );

  export const ModeDetected = BusEvent.define(
    "ingress.mode.detected",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct", "internal"]),
      target: IngressTargetLabel,
    }),
    { visibility: "ephemeral" },
  );

  export const SessionResolved = BusEvent.define(
    "ingress.session.resolved",
    Base.extend({
      sessionId: z.string(),
      isNew: z.boolean(),
      target: z.enum(["resident", "worker"]).optional(),
    }),
    { visibility: "ephemeral" },
  );

  export const Completed = BusEvent.define(
    "ingress.completed",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct", "internal"]),
      target: IngressTargetLabel,
      durationMs: z.number(),
    }),
    { visibility: "user_audit" },
  );

  export const Failed = BusEvent.define(
    "ingress.failed",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct", "internal"]),
      target: IngressTargetLabel,
      durationMs: z.number(),
      error: z.string(),
    }),
    { visibility: "llm_reason" },
  );
}
