import type { Wait } from "@openomni/protocol";
import { Wait as WaitSchemas } from "@openomni/protocol";
import { z } from "zod";

/**
 * Existing-agent messaging definitions (#215): the policy-plane sender-target
 * grant, the explicit-target send input, and the deterministic send receipt.
 *
 * The vocabulary is deliberately non-allocating: a grant bounds exactly one
 * sender to one existing target actor plus an operation set, and cannot
 * express Worker creation, delegation, WorkItem/executor assignment, budget,
 * or authority transfer — those capabilities simply do not exist here.
 * Kernel-local by design: messaging has a single kernel consumer, and the
 * blueprint's 13 protocol domains do not include messaging.
 */

export const MessageOperation = z.enum(["fire_and_forget", "awaited"]);
export type MessageOperation = z.infer<typeof MessageOperation>;

/**
 * Explicit target: always one existing actor; an optional endpoint pin
 * disambiguates actors reachable at more than one endpoint. There is no
 * broadcast or wildcard form — resolution yields exactly one delivery
 * address or a typed denial.
 */
export const MessageTarget = z
  .object({
    actorId: z.string().min(1),
    endpointId: z.string().min(1).optional(),
  })
  .strict();
export type MessageTarget = z.infer<typeof MessageTarget>;

export const SenderTargetGrant = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    targetActorId: z.string().min(1),
    operations: z.array(MessageOperation).min(1),
    expiresAt: z.number().optional(),
  })
  .strict();
export type SenderTargetGrant = z.infer<typeof SenderTargetGrant>;

/**
 * Typed denial taxonomy — callers branch on `code`, never message text.
 * Ungranted, missing, stale, and ambiguous targets all fail closed with an
 * unchanged allocation/authority surface (nothing is created or guessed).
 * `wait_duplicate` is the awaited-delivery exactly-once rule surfacing as a
 * denial: a Wait already exists for the message (or wait id), so nothing is
 * delivered and nothing changes.
 */
export const MessageDenialCode = z.enum([
  "ungranted",
  "target_missing",
  "target_stale",
  "target_ambiguous",
  "wait_duplicate",
]);
export type MessageDenialCode = z.infer<typeof MessageDenialCode>;

/**
 * The Wait an awaited delivery opens. Quorum/resolution-policy coherence is
 * NOT re-refined here — `Wait.Record.parse` at WaitStore.create is the one
 * enforcement layer for that invariant (#215 rule 4).
 */
const AwaitSpec = z
  .object({
    waitId: z.string().min(1),
    ownerRef: WaitSchemas.OwnerRef,
    allowedActions: z.array(WaitSchemas.AllowedAction).min(1),
    expectedResponders: z.array(z.string().min(1)).min(1),
    resolutionPolicy: WaitSchemas.ResolutionPolicy,
    quorum: WaitSchemas.Quorum.optional(),
    expiresAt: z.number(),
    followUpWindow: z.number().int().nonnegative(),
    /** Extra correlation fields (threadId, channelId, …); endpointId and replyToMessageId are derived from the delivery itself. */
    correlation: WaitSchemas.Correlation.optional(),
  })
  .strict();

const SendInputBase = z
  .object({
    /** Outbound message identity: doubles as the Wait's originMessageId, whose UNIQUE column pins "exactly one Wait per awaited message". */
    messageId: z.string().min(1),
    /** The sender flow's trace: every event this send leaves files under it. */
    traceId: z.string().min(1),
    senderId: z.string().min(1),
    target: MessageTarget,
    operation: MessageOperation,
    body: z.string().min(1),
    /** Injected timestamp — messaging never reads the wall clock. */
    at: z.number(),
    waitSpec: AwaitSpec.optional(),
  })
  .strict();

export const SendInput = SendInputBase.superRefine((input, ctx) => {
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
export type SendInput = z.infer<typeof SendInput>;

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

/**
 * Pure policy-plane grant evaluation: returns the first (id-ordered) active
 * grant binding this sender to this target for this operation, or undefined —
 * the caller fails closed as `ungranted`. Time is an input; an expired grant
 * is simply not active.
 */
export function resolveSenderTargetGrant(
  grants: readonly SenderTargetGrant[],
  claim: Readonly<{
    senderId: string;
    targetActorId: string;
    operation: MessageOperation;
    at: number;
  }>,
): SenderTargetGrant | undefined {
  return [...grants]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .find(
      (grant) =>
        grant.senderId === claim.senderId &&
        grant.targetActorId === claim.targetActorId &&
        grant.operations.includes(claim.operation) &&
        (grant.expiresAt === undefined || claim.at <= grant.expiresAt),
    );
}
