import { Channel, type Gateway } from "@openomni/protocol";

/**
 * Existing-agent messaging grant evaluation (#215, gateway router since #707
 * stage 2). The schema vocabulary lives in protocol as the `Gateway.Send`
 * contract (stage 0, #706); grant EVALUATION is forbidden in protocol
 * (contract boundary — schemas and pure folds only, never authority
 * evaluation), so the evaluator lives here on the perimeter.
 *
 * Two evaluators, one fail-closed split (#708 stage 3):
 * - `resolveSenderTargetGrant` — the scope-LESS base evaluator. It has no
 *   surface context, so it refuses replyScope-carrying (rule-materialized)
 *   instances outright; honoring one here would silently void its
 *   containment.
 * - `resolveScopedSenderTargetGrant` — the scope-AWARE evaluator. The send
 *   kernel calls it with the surface key derived from the RESOLVED delivery
 *   endpoint, so a materialized instance is honored exactly inside the
 *   container it was created for and refused everywhere else.
 */

type GrantClaim = Readonly<{
  senderId: string;
  targetActorId: string;
  operation: Gateway.MessageOperation;
  at: number;
}>;

function matchesClaim(grant: Gateway.SenderTargetGrant, claim: GrantClaim): boolean {
  return (
    grant.senderId === claim.senderId &&
    grant.targetActorId === claim.targetActorId &&
    grant.operations.includes(claim.operation) &&
    (grant.expiresAt === undefined || claim.at <= grant.expiresAt)
  );
}

function idOrdered(
  grants: readonly Gateway.SenderTargetGrant[],
): readonly Gateway.SenderTargetGrant[] {
  return [...grants].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * The perimeter surface key of a resolved delivery endpoint: channel +
 * externalId — the two facts a `Gateway.DeliveryTarget` and a resolved
 * inbound actor endpoint share, so materialization (inbound admission) and
 * evaluation (outbound send) derive the SAME key from the SAME endpoint.
 * Thread-level narrowing awaits the durable grant-instance store (#709).
 */
export function deliverySurfaceKey(
  endpoint: Readonly<{ channel: string; externalId: string }>,
): string {
  return Channel.SurfaceKey.create([endpoint.channel, endpoint.externalId]);
}

/**
 * Pure policy-plane grant evaluation: returns the first (id-ordered) active
 * grant binding this sender to this target for this operation, or undefined —
 * the caller fails closed as `ungranted`. Time is an input; an expired grant
 * is simply not active.
 */
export function resolveSenderTargetGrant(
  grants: readonly Gateway.SenderTargetGrant[],
  claim: GrantClaim,
): Gateway.SenderTargetGrant | undefined {
  return idOrdered(grants).find(
    (grant) =>
      // Fail-closed containment guard: no surface context here — a
      // scope-carrying (rule-materialized) instance is resolvable only by
      // the scope-aware evaluator below.
      grant.replyScope === undefined && matchesClaim(grant, claim),
  );
}

/**
 * True when at least one reply-scoped instance covers sender→target for this
 * operation at this time, scope UNCHECKED. The send kernel uses it to decide
 * whether target resolution may run at all: with no candidate the denial is
 * `ungranted` BEFORE any registry lookup (an ungranted sender learns nothing
 * from the registry); with a candidate the endpoint must resolve first,
 * because only the resolved endpoint yields the outbound surface key.
 */
export function hasScopedSenderTargetCandidate(
  grants: readonly Gateway.SenderTargetGrant[],
  claim: GrantClaim,
): boolean {
  return grants.some((grant) => grant.replyScope !== undefined && matchesClaim(grant, claim));
}

/**
 * Scope-aware evaluation of rule-materialized instances (#708): the first
 * (id-ordered) active reply-scoped instance whose `replyScope.surfaceKey`
 * equals the outbound delivery surface key. Cross-surface use fails closed —
 * the instance authorizes replies INTO the initiating container only.
 */
export function resolveScopedSenderTargetGrant(
  grants: readonly Gateway.SenderTargetGrant[],
  claim: GrantClaim & Readonly<{ surfaceKey: string }>,
): Gateway.SenderTargetGrant | undefined {
  return idOrdered(grants).find(
    (grant) =>
      grant.replyScope !== undefined &&
      grant.replyScope.surfaceKey === claim.surfaceKey &&
      matchesClaim(grant, claim),
  );
}
