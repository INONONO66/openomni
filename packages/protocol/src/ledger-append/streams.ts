import { z } from "zod";
import { DispatchSchemas } from "../dispatch/schemas.js";
import { IngressEvent, type RoutingDecisionPayload } from "../event/ingress.js";

/**
 * Owner-stream registry — the ONE place the #510 decision-class stream
 * naming is documented (C3 ruling 2). Every decision-class fact lives on
 * exactly one owner stream named `<class>:<id>`; ids are kernel-internal and
 * opaque, so the grammar needs no escaping. Conflict→error mapping is PER
 * CLASS (phase B ruling 1) and is recorded on each entry.
 *
 * Head discipline comes in two shapes:
 *   - revision-bound streams (wait/work): fact seq N is the append that
 *     produced projected revision N, so `expectedHead` is the pre-transition
 *     revision and the stream head always equals the committed row's
 *     revision;
 *   - single-fact streams (route/command): one decision per id, appended at
 *     `expectedHead` 0 (seq 1). "No record, no action" needs the durable
 *     append before the act, not contention — a conflict means the id was
 *     already decided; whether that is a replay to re-execute or an anomaly
 *     to refuse is the class's own mapping (see each entry).
 */
export const StreamRegistry = {
  wait: {
    stream: "wait:<waitId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans: "duplicate create (id reuse impossible) or stale revision — typed store error",
    factTypes: [
      "wait.opened",
      "wait.adopted",
      "wait.attached",
      "wait.resolved",
      "wait.expired",
      "wait.cancelled",
      "wait.delivery_recorded",
    ],
    status: "shipped",
  },
  work: {
    stream: "work:<workItemId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans:
      "duplicate create = stream exists = typed duplicate; stale head = typed stale_revision",
    factTypes: [
      "work_item.created",
      "work_item.adopted",
      "work_item.started",
      "work_item.completed",
      "work_item.failed",
      "work_item.cancelled",
      "work_item.updated",
      "work_item.removed",
      "work_item.retried",
      "work_item.execution_assigned",
      "work_item.blocker_added",
      "work_item.blocker_resolved",
      "work_item.evidence_appended",
      "work_item.outcome_recorded",
      "work_item.completion_request_reserved",
      "work_item.completion_reservation_released",
      "work_item.admission_accepted",
      "work_item.admission_refused",
      "work_item.attempt_allocated",
      "work_item.attempt_finished",
    ],
    status: "shipped",
  },
  route: {
    // Channel-scoped key (#510 review fix F1): normalizer-minted inbound ids
    // are only unique WITHIN a channel (Telegram per-chat counters, GitHub
    // per-issue fallback ids), so the surface + workspace + channel scope is
    // part of the stream identity — a colliding id from another channel can
    // never preempt or replay a foreign decision. Components are URI-encoded
    // (they are protocol plain strings, so a raw ":" could forge a foreign
    // scope's key).
    stream:
      'route:<uriencoded surface>:<uriencoded workspace ?? "">:<uriencoded channel ?? "">:<uriencoded inboundEventId>',
    heads: "single-fact (expectedHead 0, seq 1)",
    conflictMeans:
      "inbound event id already routed — replay is EQUIVALENCE-GATED (F2): the fresh decision must match the recorded one on stage/outcome/target/sessionId/runId/pendingInteractionId; equivalent redelivery proceeds with the fresh resolution (accepted routes re-execute idempotently, terminal decisions repeat their rejection), divergent fails closed as route_replay_divergent",
    factTypes: ["route.decided"],
    status: "shipped",
  },
  command: {
    stream: "command:<dispatchId>",
    heads: "single-fact (expectedHead 0, seq 1)",
    conflictMeans:
      "dispatch id already decided — an anomaly (dispatchId is minted per submit), fail closed",
    factTypes: ["command.authorized", "command.denied"],
    status: "shipped",
  },
  effect: {
    stream: "effect:<effectId>",
    heads: "intent at seq 1 (effectId is the idempotency key), exactly one outcome fact after",
    conflictMeans: "effect id already intended — reconciliation owns the retry (#492)",
    factTypes: ["effect.intended", "effect.confirmed", "effect.failed"],
    status: "dormant (#492 wires the drivers)",
  },
} as const;

/**
 * `route.decided` fact data (C3 ruling 1): the FULL validated
 * RoutingDecisionPayload — both accepted and terminal
 * (drop/block/deny/ambiguous) decisions. The payload owner stays the
 * `ingress.routing.decision` Bus event schema; the observe-only Bus publish
 * is a projection of this fact.
 */
export const RouteDecided: z.ZodType<RoutingDecisionPayload> = IngressEvent.RoutingDecision.schema;
export type RouteDecided = RoutingDecisionPayload;

const CommandVerdictBase = z.object({
  policyId: z.string().min(1),
  reason: z.string().min(1),
  actorKind: DispatchSchemas.ActorKind,
  action: z.string().min(1),
  targetKind: DispatchSchemas.TargetKind,
});

/**
 * `command.authorized` fact data (C3 ruling 2): the passing dispatch policy
 * verdict, appended before the handler is invoked.
 */
export const CommandAuthorized = CommandVerdictBase.extend({
  verdict: z.literal("allow"),
}).strict();
export type CommandAuthorized = z.infer<typeof CommandAuthorized>;

/**
 * `command.denied` fact data (C3 ruling 2): the blocking dispatch verdict
 * (policy deny/pending, or the pinned-interaction revalidation denial),
 * appended before the denial result returns.
 */
export const CommandDenied = CommandVerdictBase.extend({
  verdict: z.enum(["deny", "pending"]),
}).strict();
export type CommandDenied = z.infer<typeof CommandDenied>;

/**
 * Effect intent/outcome vocabulary (C3 ruling 3) — DORMANT: schema only, no
 * writer exists yet; #492 wires the drivers/reconcilers. The normative
 * sequence is `intent(pending) -> idempotent effect -> confirmed|failed` on
 * the stream `effect:<effectId>`, where `effectId` (the intent event id) is
 * the idempotency key reconciliation resolves under after a crash.
 */
export const EffectIntended = z
  .object({
    effectId: z.string().min(1),
    kind: z.string().min(1),
    target: z.string().min(1).optional(),
    workItemHash: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
  })
  .strict();
export type EffectIntended = z.infer<typeof EffectIntended>;

/** `effect.confirmed` — the driver's definite success receipt (#492-wired). */
export const EffectConfirmed = z
  .object({
    effectId: z.string().min(1),
    receipt: z.string().min(1).optional(),
  })
  .strict();
export type EffectConfirmed = z.infer<typeof EffectConfirmed>;

/** `effect.failed` — the driver's definite failure, distinct from unknown (#492-wired). */
export const EffectFailed = z
  .object({
    effectId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type EffectFailed = z.infer<typeof EffectFailed>;
