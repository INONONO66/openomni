import { Gateway } from "@openomni/protocol";

/**
 * Existing-agent messaging definitions (#215). The schema vocabulary was
 * re-homed to `protocol` as the `Gateway.Send` contract (gateway stage 0,
 * #706 — docs/gateway-design.md §2b); this module re-exports it unchanged
 * for the kernel's consumers until stage 2 moves the kernel itself into
 * `@openomni/channels`.
 *
 * `resolveSenderTargetGrant` stays here on purpose: grant EVALUATION is
 * forbidden in protocol (contract boundary — schemas and pure folds only,
 * never authority evaluation). It moves to the gateway router at stage 2.
 */

export const MessageOperation = Gateway.MessageOperation;
export type MessageOperation = Gateway.MessageOperation;

export const MessageTarget = Gateway.MessageTarget;
export type MessageTarget = Gateway.MessageTarget;

export const SenderTargetGrant = Gateway.SenderTargetGrant;
export type SenderTargetGrant = Gateway.SenderTargetGrant;

export const MessageDenialCode = Gateway.MessageDenialCode;
export type MessageDenialCode = Gateway.MessageDenialCode;

export const SendInput = Gateway.SendInput;
export type SendInput = Gateway.SendInput;

export type DeliveryTarget = Gateway.DeliveryTarget;
export type SendReceipt = Gateway.SendReceipt;

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
        // Fail-closed containment guard: this evaluator has no surface
        // context, so it CANNOT check replyScope — a scope-carrying
        // (rule-materialized) instance is resolvable only by the scope-aware
        // gateway evaluator (stage 2). Honoring it here would silently void
        // the containment the instance was created with.
        grant.replyScope === undefined &&
        grant.senderId === claim.senderId &&
        grant.targetActorId === claim.targetActorId &&
        grant.operations.includes(claim.operation) &&
        (grant.expiresAt === undefined || claim.at <= grant.expiresAt),
    );
}
