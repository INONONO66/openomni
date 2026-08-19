import { z } from "zod";
import { Actor } from "../actor/index.js";
import { Events as IngressEvents } from "../event/ingress.js";
import { Ingress } from "../ingress/index.js";
import { Wait } from "../wait/index.js";

/**
 * Gateway contracts (docs/gateway-design.md §2, stage 0 — #706).
 *
 * The gateway (`@openomni/channels` after stage 2) and the brain
 * (`@openomni/openomni`) never import each other; these schemas are the only
 * seam, wired by apps/server through injected ports.
 *
 * Trust vocabulary (§3): *perimeter trust* — who may reach us / whom we may
 * reach (admission, grants, wait correlation, egress budget) — is
 * gateway-owned and arrives in `ActorContext` as a verdict the brain consumes
 * verbatim. *Conduct trust* — what the agent may do once running (tool
 * policy, completion admission, evidence) — is brain-owned and never crosses
 * this seam. Schemas only: evaluation of either plane lives above protocol.
 */

/** Taint root for injection defense: where the content physically entered. */
const OriginSchema = z
  .object({
    surface: z.string().min(1),
    externalId: z.string().min(1),
  })
  .strict();

/**
 * The perimeter verdict attached to every delivery. `actorId` is absent for
 * anonymous senders admitted via a channel defaultTier. The brain consumes
 * `trustTier`/`inboundTreatment` verbatim (perimeter output = conduct input)
 * and frames `evidence_only` turns as evidence, never as user commands.
 */
const DeliveredTreatmentSchema = z.enum(["full_access", "evidence_only"]);

const ActorContextSchema = z
  .object({
    actorId: z.string().min(1).optional(),
    trustTier: Actor.TrustTier,
    /**
     * Narrower than Actor.InboundTreatment on purpose: "drop" means the
     * message was never delivered, so a Deliver stamped drop must be
     * unrepresentable at this seam.
     */
    inboundTreatment: DeliveredTreatmentSchema,
    origin: OriginSchema,
  })
  .strict();

/** Wire-shape media reference (no raw bytes at this seam). */
const MediaSchema = z
  .object({
    kind: z.enum(["image", "file", "audio", "video"]),
    url: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
  })
  .strict()
  .refine((media) => media.url !== undefined || media.filename !== undefined, {
    message: "a media reference needs at least a url or a filename",
  });

/** The normalized message a channel driver produced from a platform payload. */
const InboundMessageSchema = z
  .object({
    messageId: z.string().min(1),
    /** Minted at the driver's first frame (D11 origin), carried unchanged. */
    traceId: z.string().min(1),
    surfaceKey: z.string().min(1),
    text: z.string(),
    media: z.array(MediaSchema).optional(),
    threadId: z.string().min(1).optional(),
    replyToId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Present iff this delivery resumed an open Wait. The expected-responder
 * gate (§2a-1) has already run perimeter-side: a correlated message from a
 * non-responder is delivered WITHOUT waitContext — attachment is itself the
 * perimeter's assertion that the sender may resume this wait.
 */
const WaitContextSchema = z
  .object({
    waitId: z.string().min(1),
    allowedAction: Wait.AllowedAction,
    engagementId: z.string().min(1).optional(),
  })
  .strict();

/**
 * The routed inbound event as it crosses the seam (#707 stage-2, measured at
 * cut): the driver-produced event AFTER perimeter routing (actor resolution,
 * channel-grant treatment stamping, wait/session pinning) MINUS the
 * brain-owned `agent` — the AgentDef is brain material and is resolved by the
 * brain's Deliver consumer, never embedded at the perimeter. This is the
 * execution-authoritative residue for this stage; the sibling `message` /
 * `actorContext` fields are the §2a verdict projection of the same delivery.
 */
const DeliveredEventSchema = Ingress.DirectEventSchema.omit({ agent: true });

/**
 * Inbound contract: gateway → brain.
 *
 * Stage-2 measurement corrections to the stage-0 draft (#707):
 * - `sessionId` is optional — it is the gateway's routed session label
 *   (wait-owner / surface-map / router-minted). Worker-target deliveries
 *   carry no label: work placement (child/worker session selection) is brain
 *   judgment (kernel-contract §8.5), so the brain resolves it from the
 *   pinned event.
 * - `actorContext` is optional — present for surface-default admissions
 *   (where the perimeter produced a tier verdict); absent for wait/pending
 *   resumptions (admission is the correlation itself, asserted via
 *   `waitContext`) and for legacy anonymous surfaces without an origin id.
 * - `event` + `decision` carry the routed event residue and the recorded
 *   route.decided fact — the brain parses all three at the seam.
 */
const DeliverSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    message: InboundMessageSchema,
    actorContext: ActorContextSchema.optional(),
    waitContext: WaitContextSchema.optional(),
    event: DeliveredEventSchema,
    /** The recorded route.decided fact this delivery executes (record-before-act). */
    decision: IngressEvents.RoutingDecision.schema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Outbound vocabulary — re-homed from the #215 messaging kernel verbatim
// (openomni/messaging re-exports these until stage 2 moves the kernel).
// Grant *evaluation* stays above protocol (grant evaluation is forbidden
// here per the contract boundary); only the shapes live at the seam.
// ---------------------------------------------------------------------------

const MessageOperationSchema = z.enum(["fire_and_forget", "awaited"]);

/**
 * Explicit target: always one existing actor; an optional endpoint pin
 * disambiguates actors reachable at more than one endpoint. No broadcast or
 * wildcard form — resolution yields exactly one delivery address or a typed
 * denial.
 */
const MessageTargetSchema = z
  .object({
    actorId: z.string().min(1),
    endpointId: z.string().min(1).optional(),
  })
  .strict();

const SenderTargetGrantSchema = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    targetActorId: z.string().min(1),
    operations: z.array(MessageOperationSchema).min(1),
    expiresAt: z.number().optional(),
    /** Present iff this grant was materialized from a ReplyGrantRule — the provenance link that makes `maxLiveInstances` countable. */
    ruleId: z.string().min(1).optional(),
    /** Perimeter-fact scope of a materialized instance: replies stay inside the initiating container. */
    replyScope: z
      .object({ surfaceKey: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    // A rule-materialized instance is always bounded: containment + expiry
    // are what distinguish it from an Owner-written standing grant.
    if (grant.ruleId !== undefined) {
      if (grant.replyScope === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a rule-materialized grant requires replyScope (perimeter containment)",
          path: ["replyScope"],
        });
      }
      if (grant.expiresAt === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a rule-materialized grant requires expiresAt (instanceTtlMs bound)",
          path: ["expiresAt"],
        });
      }
    } else if (grant.replyScope !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "replyScope without ruleId — reply containment has no owning rule",
        path: ["ruleId"],
      });
    }
  });

/**
 * Owner-written rule row from which the gateway mechanically materializes
 * reply-scoped SenderTargetGrant instances for first-contact initiators on
 * the covered channel (§2b). Instances are scoped by perimeter facts only
 * (initiator actorId + originating thread/surfaceKey + `instanceTtlMs`);
 * `maxLiveInstances` bounds grant farming by mass first contact.
 */
const ReplyGrantRuleSchema = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    surface: z.string().min(1),
    workspace: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    operations: z.array(MessageOperationSchema).min(1),
    instanceTtlMs: z.number().int().positive(),
    maxLiveInstances: z.number().int().positive(),
    createdBy: z.string().min(1),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .strict();

/**
 * Typed denial taxonomy — callers branch on `code`, never message text.
 * Ungranted, missing, stale, and ambiguous targets all fail closed with an
 * unchanged allocation/authority surface. `wait_duplicate` is the
 * awaited-delivery exactly-once rule surfacing as a denial.
 */
const MessageDenialCodeSchema = z.enum([
  "ungranted",
  "target_missing",
  "target_stale",
  "target_ambiguous",
  "wait_duplicate",
]);

/**
 * The Wait an awaited delivery opens. Quorum/resolution-policy coherence is
 * NOT re-refined here — `Wait.Record.parse` at WaitStore.create is the one
 * enforcement layer for that invariant (#215 rule 4).
 */
const AwaitSpecSchema = z
  .object({
    waitId: z.string().min(1),
    ownerRef: Wait.OwnerRef,
    allowedActions: z.array(Wait.AllowedAction).min(1),
    expectedResponders: z.array(z.string().min(1)).min(1),
    resolutionPolicy: Wait.ResolutionPolicy,
    quorum: Wait.Quorum.optional(),
    expiresAt: z.number(),
    followUpWindow: z.number().int().nonnegative(),
    /** Extra correlation fields (threadId, channelId, …); endpointId and replyToMessageId are derived from the delivery itself. */
    correlation: Wait.Correlation.optional(),
  })
  .strict();

const SendInputBase = z
  .object({
    /** Outbound message identity: doubles as the Wait's originMessageId, whose UNIQUE column pins "exactly one Wait per awaited message". */
    messageId: z.string().min(1),
    /** The sender flow's trace: every event this send leaves files under it. */
    traceId: z.string().min(1),
    senderId: z.string().min(1),
    target: MessageTargetSchema,
    operation: MessageOperationSchema,
    body: z.string().min(1),
    /** Injected timestamp — messaging never reads the wall clock. */
    at: z.number(),
    waitSpec: AwaitSpecSchema.optional(),
  })
  .strict();

const SendInputSchema = SendInputBase.superRefine((input, ctx) => {
  if (input.operation === "awaited" && input.waitSpec === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "awaited operation requires a waitSpec",
      path: ["waitSpec"],
    });
  }
  if (input.operation === "fire_and_forget" && input.waitSpec !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "fire_and_forget never opens a Wait — waitSpec is not allowed",
      path: ["waitSpec"],
    });
  }
});

// ---------------------------------------------------------------------------
// Wait control — brain → gateway (§2b-1): the brain owns WHEN a wait should
// stop mattering; the gateway owns the rows and executes the write.
// ---------------------------------------------------------------------------

const WaitControlActionSchema = z.enum(["cancel", "expire_now"]);

const WaitControlSchema = z
  .object({
    waitId: z.string().min(1),
    action: WaitControlActionSchema,
    reason: z.string().min(1),
  })
  .strict();

export namespace Gateway {
  export const Origin = OriginSchema;
  export type Origin = z.infer<typeof OriginSchema>;

  export const ActorContext = ActorContextSchema;
  export type ActorContext = z.infer<typeof ActorContextSchema>;

  export const Media = MediaSchema;
  export type Media = z.infer<typeof MediaSchema>;

  export const InboundMessage = InboundMessageSchema;
  export type InboundMessage = z.infer<typeof InboundMessageSchema>;

  export const WaitContext = WaitContextSchema;
  export type WaitContext = z.infer<typeof WaitContextSchema>;

  export const DeliveredEvent = DeliveredEventSchema;
  export type DeliveredEvent = z.infer<typeof DeliveredEventSchema>;

  export const Deliver = DeliverSchema;
  export type Deliver = z.infer<typeof DeliverSchema>;

  export const MessageOperation = MessageOperationSchema;
  export type MessageOperation = z.infer<typeof MessageOperationSchema>;

  export const MessageTarget = MessageTargetSchema;
  export type MessageTarget = z.infer<typeof MessageTargetSchema>;

  export const SenderTargetGrant = SenderTargetGrantSchema;
  export type SenderTargetGrant = z.infer<typeof SenderTargetGrantSchema>;

  export const ReplyGrantRule = ReplyGrantRuleSchema;
  export type ReplyGrantRule = z.infer<typeof ReplyGrantRuleSchema>;

  export const MessageDenialCode = MessageDenialCodeSchema;
  export type MessageDenialCode = z.infer<typeof MessageDenialCodeSchema>;

  export const AwaitSpec = AwaitSpecSchema;
  export type AwaitSpec = z.infer<typeof AwaitSpecSchema>;

  export const SendInput = SendInputSchema;
  export type SendInput = z.infer<typeof SendInputSchema>;

  /** The one allocated delivery address a target resolves to. */
  export type DeliveryTarget = Readonly<{
    actorId: string;
    endpointId: string;
    channel: string;
    externalId: string;
  }>;

  /**
   * Deterministic send receipt. `sent`/`denied` and the denial code are the
   * audit facts; a `wait` is present exactly when the operation was awaited.
   */
  export type SendReceipt =
    | Readonly<{
        kind: "sent";
        operation: "fire_and_forget";
        messageId: string;
        senderId: string;
        grantId: string;
        target: DeliveryTarget;
        at: number;
      }>
    | Readonly<{
        kind: "sent";
        operation: "awaited";
        messageId: string;
        senderId: string;
        grantId: string;
        target: DeliveryTarget;
        wait: Wait.Record;
        at: number;
      }>
    | Readonly<{
        kind: "denied";
        code: MessageDenialCode;
        messageId: string;
        senderId: string;
        targetActorId: string;
        reason: string;
        at: number;
      }>;

  export const WaitControlAction = WaitControlActionSchema;
  export type WaitControlAction = z.infer<typeof WaitControlActionSchema>;

  export const WaitControl = WaitControlSchema;
  export type WaitControl = z.infer<typeof WaitControlSchema>;

  /** Writes stay gateway-side; rejection is typed, never message text. */
  export type WaitControlReceipt =
    | Readonly<{ kind: "cancelled" | "expired"; waitId: string; at: number }>
    | Readonly<{
        kind: "rejected";
        waitId: string;
        code: "not_found" | "already_terminal";
        reason: string;
        at: number;
      }>;
}
