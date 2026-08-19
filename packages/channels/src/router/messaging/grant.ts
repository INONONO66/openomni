import type { Gateway } from "@openomni/protocol";

/**
 * Existing-agent messaging grant evaluation (#215, gateway router since #707
 * stage 2). The schema vocabulary lives in protocol as the `Gateway.Send`
 * contract (stage 0, #706); grant EVALUATION is forbidden in protocol
 * (contract boundary — schemas and pure folds only, never authority
 * evaluation), so the evaluator lives here on the perimeter.
 *
 * Pure policy-plane grant evaluation: returns the first (id-ordered) active
 * grant binding this sender to this target for this operation, or undefined —
 * the caller fails closed as `ungranted`. Time is an input; an expired grant
 * is simply not active.
 */
export function resolveSenderTargetGrant(
  grants: readonly Gateway.SenderTargetGrant[],
  claim: Readonly<{
    senderId: string;
    targetActorId: string;
    operation: Gateway.MessageOperation;
    at: number;
  }>,
): Gateway.SenderTargetGrant | undefined {
  return [...grants]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .find(
      (grant) =>
        // Fail-closed containment guard: this evaluator has no surface
        // context, so it CANNOT check replyScope — a scope-carrying
        // (rule-materialized) instance is resolvable only by a scope-aware
        // evaluator (stage 3). Honoring it here would silently void the
        // containment the instance was created with.
        grant.replyScope === undefined &&
        grant.senderId === claim.senderId &&
        grant.targetActorId === claim.targetActorId &&
        grant.operations.includes(claim.operation) &&
        (grant.expiresAt === undefined || claim.at <= grant.expiresAt),
    );
}
