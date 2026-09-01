import { z } from "zod";
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
 *   - single-fact streams (route): one decision per id, appended at
 *     `expectedHead` 0 (seq 1). "No record, no action" needs the durable
 *     append before the act, not contention — a conflict means the id was
 *     already decided; whether that is a replay to re-execute or an anomaly
 *     to refuse is the class's own mapping (see each entry).
 */
export const StreamRegistry = {
  // SHIPPED — ledger WaitStore publishes; SQLite ledger append/projection consumes.
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
  // SHIPPED — ledger ConversationStore publishes; SQLite ledger append/projection consumes.
  conversation: {
    stream: "conversation:<conversationId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans: "duplicate create (id reuse impossible) or stale revision — typed store error",
    factTypes: [
      "conversation.opened",
      "conversation.closed",
      "conversation.outbound_admitted",
      "conversation.inbound_recorded",
      "conversation.cap_breached",
    ],
    status: "shipped",
  },
  // SHIPPED — ledger LeaseStore publishes; SQLite ledger append/projection consumes.
  lease: {
    stream: "lease:<leaseId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans: "duplicate create (id reuse impossible) or stale revision — typed store error",
    factTypes: ["lease.issued", "lease.debited", "lease.closed"],
    status: "shipped",
  },
  // SHIPPED — ledger WorkItem fact writers publish; SQLite ledger append/projection consumes.
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
  // SHIPPED — channels routing resolution publishes and its replay gate consumes via headFact.
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
      "inbound event id already routed — replay is EQUIVALENCE-GATED (F2): the fresh decision must match the recorded one on stage/outcome/target/sessionId; equivalent redelivery proceeds with the fresh resolution (accepted routes re-execute idempotently, terminal decisions repeat their rejection), divergent fails closed as route_replay_divergent",
    factTypes: ["route.decided"],
    status: "shipped",
  },
  // SHIPPED — channels routing execution publishes and consumes corrections via headFact.
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
  // SHIPPED — ledger EngagementStore publishes; SQLite ledger append/projection consumes.
  engagement: {
    stream: "engagement:<engagementId>",
    heads: "revision-bound (expectedHead = revision before the transition)",
    conflictMeans:
      "duplicate create = stream exists = typed duplicate; stale head = typed revision_conflict",
    factTypes: ["engagement.opened", "engagement.transitioned", "engagement.expired"],
    status:
      "shipped (#709 — writer at ledger engagement/index.ts; brain sole writer, gateway-design §4/§5)",
  },
  // SHIPPED — channels messaging send publishes and its retry admission consumes via headFact.
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
