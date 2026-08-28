import type { Actor } from "@openomni/protocol";

/** Resolves the channel-grant tier used when the actor has no trust tier. */
export function effectiveTrustTier(
  actorTier: Actor.TrustTier | undefined,
  defaultTier: Actor.TrustTier | undefined,
): Actor.TrustTier | undefined {
  return actorTier ?? defaultTier;
}
