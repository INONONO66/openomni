import { z } from "zod";
import { Actor } from "../actor/index.js";
import { Channel } from "../channel/index.js";
import {
  Events as EventDescriptors,
  recordedRoutingDecision as recordedRoutingDecisionReader,
  type RoutingDecisionPayload as RoutingDecisionPayloadType,
} from "../event/ingress.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";
import { Wait } from "../wait/index.js";
import * as RouteRecord from "./route-record.js";
import { EpochMs } from "../time.js";

/**
 * #500 A6: every production-written actor key is declared (`runId` and
 * `agentName` land from the dispatch resident seam; the rest were already
 * typed). The catchall stays as the historical inbound-tolerance seam for
 * external events — no production producer writes undeclared keys today, and
 * the actor vocabulary reshape itself is deferred to gateway stage 2 (#707).
 */
const ActorSchemaImpl = z
  .object({
    id: z.string().optional(),
    actorId: z.string().optional(),
    role: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    trustTier: Actor.TrustTier.optional(),
    endpointId: z.string().optional(),
    endpoint: Actor.Endpoint.optional(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    agentName: z.string().optional(),
    workerId: z.string().optional(),
    isResident: z.boolean().optional(),
    isMain: z.boolean().optional(),
  })
  .catchall(z.unknown());

/**
 * The two executable delivery kinds. `workerId` is the string-form
 * ("worker:<id>") wire artifact this seam owns; the catchall keeps the
 * historical tolerance for extra inbound keys.
 */
const RawTargetSchema = z
  .object({
    kind: z.enum(["resident", "worker"]),
    sessionId: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
    workerId: z.string().optional(),
  })
  .catchall(z.unknown());

const TargetSchemaImpl = z.preprocess((input) => {
  if (input === "resident") return { kind: "resident" };
  if (typeof input === "string" && input.startsWith("worker:")) {
    const id = input.slice("worker:".length);
    return { kind: "worker", workerId: id };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.type === "string" && record.kind === undefined) {
      const { type, ...rest } = record;
      return { ...rest, kind: type };
    }
  }
  return input;
}, RawTargetSchema);

/**
 * #500 A3: the one lifecycle that rides an inbound event is the WORKER axis
 * (cancel requests read "stopping"). The resident axis (sleeping / hydrating /
 * active / idle / releasing) is in-process ResidentRuntime activation state
 * and has zero writers and zero readers on this field — it never rides the
 * event, so it is not part of this vocabulary.
 */
const WorkerLifecycleSchema = z.enum(["starting", "ready", "busy", "stopping", "exited"]);

const ActivationMetadataSchemaImpl = z
  .object({
    durableSessionId: z.string().optional(),
    activationId: z.string().optional(),
    runId: z.string().optional(),
    lifecycle: WorkerLifecycleSchema.optional(),
    /**
     * #500 A2: background worker dispatch flag — a declared, serializable
     * field (previously smuggled through the catchall).
     */
    background: z.boolean().optional(),
    trigger: z
      .object({
        kind: z.enum(["cron", "webhook", "manual", "internal"]),
        id: z.string().optional(),
        scheduledAt: EpochMs.optional(),
        firedAt: EpochMs.optional(),
        attempt: z.number().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

/** The inbound sender identity a channel driver carries (Channel.InboundMessage.sender). */
const SenderMetaSchema = z
  .object({ id: z.string(), name: z.string().optional() })
  .catchall(z.unknown());

/**
 * batch ② commit 2 (#500 A6 pattern): the production-written meta keys read
 * for AUTHORIZATION (inboundTreatment, channelGrant*, correlation) and for the
 * projection/audit path (surfaceKey, kind, sender, threadId, replyToId,
 * agentName) are declared as typed optional fields instead of
 * riding the untyped `.catchall(z.unknown())`. The catchall is RETAINED for
 * the external DirectEventSchema.parse boundary: meta carries `raw` (the
 * arbitrary per-platform payload, Channel.InboundMessage.raw) and a channel
 * driver may attach further escape-hatch keys — genuinely unknown, never an
 * authorization input. meta is in-process on InboundEvent and never persisted.
 */
const MetaSchemaImpl = z
  .object({
    actor: ActorSchemaImpl.optional(),
    target: TargetSchemaImpl.optional(),
    inboundTreatment: Actor.InboundTreatment.optional(),
    channelGrantId: z.string().optional(),
    channelGrantKind: Actor.ChannelGrantKind.optional(),
    surfaceKey: z.string().optional(),
    kind: z.string().optional(),
    sender: SenderMetaSchema.optional(),
    threadId: z.string().optional(),
    replyToId: z.string().optional(),
    agentName: z.string().optional(),
    correlation: Wait.Correlation.optional(),
  })
  .catchall(z.unknown());

export namespace Ingress {
  export const ActorSchema = ActorSchemaImpl;
  export type Actor = z.infer<typeof ActorSchema>;

  export const TargetSchema = TargetSchemaImpl;
  export type Target = z.infer<typeof TargetSchema>;

  export const MetaSchema = MetaSchemaImpl;
  export type Meta = z.infer<typeof MetaSchema>;

  export const WorkerLifecycle = WorkerLifecycleSchema;
  export type WorkerLifecycle = z.infer<typeof WorkerLifecycleSchema>;

  export type ActivationMetadata = z.infer<typeof ActivationMetadataSchemaImpl>;

  /**
   * The zod half of a delivered agent config; only the in-process callback
   * half below is ingress-specific. `.passthrough()` keeps the historical
   * inbound tolerance for extra keys.
   */
  export const AgentDefSchema = z
    .object({
      model: Model.Ref,
      systemPrompt: z.string().optional(),
      tools: z.array(Tool.Spec).optional(),
      budget: Actor.Profile.Budget.optional(),
      permissions: Policy.Permission.optional(),
      policyPlan: Policy.PolicyPlan.optional(),
      toolConfig: Tool.Config.optional(),
    })
    .passthrough();
  // Runtime callbacks can't be expressed in Zod.
  export type AgentDef = z.infer<typeof AgentDefSchema> & {
    toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
    toolExecutorFactory?: (ctx: {
      sessionId: string;
      runId: string;
      agentName?: string;
      workspaceRoot?: string;
      /**
       * #709: engagement resumption context of the run — present iff the
       * triggering delivery carried `waitContext.engagementId`. Rides into
       * tool execution as an executor-owned implicit input (never
       * model-supplied), the same rail as sessionId.
       */
      engagementId?: string;
      /**
       * #709: the triggering delivery's perimeter trust verdict
       * (`actorContext.trustTier`, consumed verbatim per gateway-design §3).
       * The engagement approval gate reads it; absent for wait resumptions,
       * anonymous surfaces, and internal runs — which therefore can never
       * approve.
       */
      actorTrustTier?: string;
    }) => (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  };

  const InboundEventBase = {
    id: z.string(),
    /** D11: minted once at the producer's first frame (channel surface, cron fire, dispatch command) — ingress inherits, never re-mints. */
    traceId: z.string(),
    surface: z.string(),
    channel: z.string().optional(),
    workspace: z.string().optional(),
    userId: z.string().optional(),
    payload: z.unknown(),
    target: TargetSchemaImpl.optional(),
    meta: MetaSchemaImpl.optional(),
    /** #500 A1: activation-scoped metadata (in-process only, never persisted). */
    activation: ActivationMetadataSchemaImpl.optional(),
  };

  export const DirectEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("direct"),
    agent: AgentDefSchema,
  });
  export type DirectEvent = z.infer<typeof DirectEventSchema> & { agent: AgentDef };

  export const InternalEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("internal"),
    agentName: z.string(),
  });
  export type InternalEvent = z.infer<typeof InternalEventSchema>;

  export const InboundEventSchema = z.discriminatedUnion("mode", [
    DirectEventSchema,
    InternalEventSchema,
  ]);
  export type InboundEvent = DirectEvent | InternalEvent;
  export type ResolvedInboundEvent = DirectEvent | (InternalEvent & { agent: AgentDef });

  type DirectResult = {
    output: string;
    finishReason: string;
  };

  export type ExecutedIngressResult = {
    kind?: "executed";
    mode: "direct" | "internal";
    target: Target;
    sessionId: string;
    result: DirectResult;
  };

  export type DroppedIngressResult = {
    kind: "dropped";
    mode: "direct" | "internal";
    target: Target;
    reason: string;
  };

  export type IngressResult = ExecutedIngressResult | DroppedIngressResult;

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
  export const recordedRoutingDecision = recordedRoutingDecisionReader;
  export type RoutingDecisionPayload = RoutingDecisionPayloadType;

  /**
   * Shared `route.decided` recorder core (batch ② commit 1) — the PURE parts
   * both ingress arms (external gateway router / internal brain path) import
   * so the two once byte-identical recorders can no longer drift. Each arm
   * still owns its append (its own scoped `LedgerAppend.port()` + typed error).
   */
  export type RouteStreamScope = RouteRecord.RouteStreamScope;
  export const ROUTE_DECIDED_FACT_TYPE = RouteRecord.ROUTE_DECIDED_FACT_TYPE;
  export const routeStreamId = RouteRecord.routeStreamId;
  export const routeDecidedFact = RouteRecord.routeDecidedFact;
  export const routeDecisionsEquivalent = RouteRecord.routeDecisionsEquivalent;

  /** batch ② commit 4 — the route_correction (route.not_delivered) fact helpers. */
  export const ROUTE_NOT_DELIVERED_FACT_TYPE = RouteRecord.ROUTE_NOT_DELIVERED_FACT_TYPE;
  export const routeCorrectionStreamId = RouteRecord.routeCorrectionStreamId;
  export const routeNotDeliveredFact = RouteRecord.routeNotDeliveredFact;
}

/**
 * Pure target resolution over the Ingress vocabulary (#707 hoist): both
 * planes (ingress routing and brain-side projection/authority labels) fold
 * the same explicit-target > meta-target > resident-default precedence and
 * the same stable target key. No store access, no defaulting judgment —
 * absent targets are a protocol fact (resident), not a routing decision.
 */
export function resolveTarget(event: {
  target?: Ingress.Target;
  meta?: { target?: Ingress.Target };
}): Ingress.Target {
  if (event.target) return Ingress.TargetSchema.parse(event.target);
  if (event.meta?.target) return Ingress.TargetSchema.parse(event.meta.target);
  return { kind: "resident" };
}

export function targetKey(target: Ingress.Target): string {
  if (target.kind === "resident") {
    return target.sessionId ? `resident:${target.sessionId}` : "resident";
  }
  if (target.sessionId) return `worker-session:${target.sessionId}`;
  return target.workerId ? `worker:${target.workerId}` : "worker";
}

/**
 * THE surface-key map key for an inbound event (#707 stage-2 hoist from the
 * kernel session resolver). Pure fold over protocol vocabulary — both the
 * gateway router (external claim, record-before-act) and the brain (internal
 * cron/dispatch surface sessions) derive the SAME byte-frozen key from the
 * same event shape, so the persisted surface↔session rows can never fork by
 * copy drift.
 *
 * Format: "surface:workspace:channel" for legacy events. Explicit ADR-008
 * targets append `target:<target-key>` so resident and worker sessions do
 * not collide.
 */
export function extractSurfaceKey(event: {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  meta?: Ingress.Meta;
}): string {
  const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
  const target = event.target || event.meta?.target ? resolveTarget(event) : undefined;
  if (target && target.kind !== "resident") {
    parts.push("target", targetKey(target));
  }
  return Channel.SurfaceKey.create(parts);
}

/**
 * THE canonical inbound payload-text parser (#707 stage-2 hoist from the
 * kernel ingress handlers): a string payload is the text, a `{ text: string }`
 * envelope unwraps, anything else round-trips through JSON (nullish and
 * non-serializable payloads fail safe to ""). The payload shape is minted at
 * the perimeter and consumed by the brain — one pure parser in protocol keeps
 * both sides byte-identical instead of drifting copies.
 */
export function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    return (payload as { text: string }).text;
  }
  if (payload === null || payload === undefined) return "";
  return JSON.stringify(payload) ?? "";
}
