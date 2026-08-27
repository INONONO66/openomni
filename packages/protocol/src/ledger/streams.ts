import { z } from "zod";
import { Actor } from "../actor/index.js";
import { CommandSchemas } from "../command/schemas.js";
import { Events as IngressEvents, type RoutingDecisionPayload } from "../event/ingress.js";

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
  route_correction: {
    // batch ② commit 4: the route stream records the routing DECISION; when a
    // routed wait-correlated delivery is then rejected fail-closed at the wait
    // fold (a non-responder must not resume a wait — gateway-design §2a-1),
    // route.decided already says outcome:route but the delivery never
    // happened. This SEPARATE single-fact stream corrects the ledger without
    // touching the route stream's single-fact route.decided replay gate.
    stream:
      'route_correction:<uriencoded surface>:<uriencoded workspace ?? "">:<uriencoded channel ?? "">:<uriencoded inboundEventId>',
    heads: "single-fact (expectedHead 0, seq 1)",
    conflictMeans:
      "inbound already corrected as not-delivered — an idempotent redelivery of the same rejected wait reply; the recorded route.not_delivered fact stands, no second fact",
    factTypes: ["route.not_delivered"],
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
  engagement: {
    stream: "engagement:<engagementId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans:
      "duplicate create = stream exists = typed duplicate; stale head = typed revision_conflict",
    factTypes: ["engagement.opened", "engagement.transitioned", "engagement.expired"],
    status:
      "shipped (#709 — writer at ledger engagement/index.ts; brain sole writer, gateway-design §4/§5)",
  },
  gateway_send: {
    stream: "gateway_send:<uriencoded messageId>",
    heads: "single-fact (expectedHead 0, seq 1)",
    conflictMeans:
      "message id already admitted — equivalent retries resume the recorded send; divergent content fails closed",
    factTypes: ["gateway.send.admitted"],
    status: "shipped",
  },
} as const;

/**
 * `route.decided` fact data (C3 ruling 1): the FULL validated
 * RoutingDecisionPayload — both accepted and terminal
 * (drop/block/deny/ambiguous) decisions. The payload owner stays the
 * `ingress.routing.decision` Bus event schema; the observe-only Bus publish
 * is a projection of this fact.
 */
export const RouteDecided: z.ZodType<RoutingDecisionPayload> = IngressEvents.RoutingDecision.schema;
export type RouteDecided = RoutingDecisionPayload;

/**
 * `route.not_delivered` fact data (batch ② commit 4): the correcting fact for
 * a routed wait-correlated inbound whose reply was rejected fail-closed at the
 * wait fold and dropped. Recorded on the `route_correction:<scope>:<id>`
 * stream so the ledger reflects the non-delivery the route.decided fact would
 * otherwise misreport as a completed route.
 */
export const RouteNotDelivered = z
  .object({
    inboundId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type RouteNotDelivered = z.infer<typeof RouteNotDelivered>;

/**
 * #498 A2 historical upcast — command verdict facts recorded before the
 * actor-kind convergence carry the retired Command.ActorKind values. The
 * persisted bytes never change; a consumer that parses a fact through this
 * schema reads the canonical vocabulary. NOTE the current read paths: the
 * production writer (openomni dispatch runtime) appends raw fact data and
 * nothing in production re-parses it yet — these schemas are the write-side
 * vocabulary descriptors, and the p2-ledger-baseline conformance suite is the
 * one consumer that parses facts back. The upcast lives here so every future
 * reader inherits it.
 */
const LEGACY_ACTOR_KIND_UPCAST: Readonly<Record<string, Actor.Kind>> = {
  user: "human",
  worker: "internal_worker",
};

const CommandActorKind = z.preprocess(
  (value) =>
    typeof value === "string" && value in LEGACY_ACTOR_KIND_UPCAST
      ? LEGACY_ACTOR_KIND_UPCAST[value]
      : value,
  Actor.Kind,
);

const CommandVerdictBase = z.object({
  policyId: z.string().min(1),
  reason: z.string().min(1),
  actorKind: CommandActorKind,
  action: z.string().min(1),
  targetKind: CommandSchemas.TargetKind,
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
