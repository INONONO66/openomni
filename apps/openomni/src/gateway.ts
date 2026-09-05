import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
} from "@openomni/channels";
import { ChannelGrantStore } from "@openomni/ledger";
import type { Actor, Gateway, Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/agent";

/**
 * The tier a named channel surface mounts with when no Owner decision
 * declares one (#931): the least authority the protocol tier vocabulary
 * carries. Mounting is not an authority decision — a surface that merely
 * exists grants the weakest standing there is, and every raise above it is
 * an explicit declaration (`ChannelInstance.grant.defaultTier`).
 */
export const MOUNTED_CHANNEL_DEFAULT_TIER: Actor.TrustTier = "assigned_worker";

/**
 * The one owner-tier decision this app makes (#931): the loopback `ws`
 * bootstrap surface (docs/provisioning-and-providers.md §6), token-gated off
 * loopback by `assertWsExposure`. It is named here so the single call site
 * that holds it is greppable and no other caller can inherit it.
 */
const LOOPBACK_BOOTSTRAP_TIER: Actor.TrustTier = "owner";

/** The authority one surface's trusted-channel grant materializes. */
export interface TrustedChannelGrant {
  readonly surface: string;
  /**
   * The tier senders on this surface resolve to when they carry no registered
   * identity. Always explicit: owner authority exists only where a call site
   * names it (the loopback `ws` bootstrap).
   */
  readonly defaultTier: Actor.TrustTier;
  readonly allowedSenders?: readonly string[];
}

/**
 * Registers the Resident's trusted-channel authority for one surface and
 * returns the revoker. A channel component holds this while mounted: the
 * grant exists exactly as long as the component serves the surface, so an
 * unmounted channel's inbound traffic loses `trusted_channel` treatment and
 * the perimeter refuses it fail-closed. Grants are current authority, not
 * history — revoking one erases no recorded fact.
 */
export function registerTrustedChannelGrant(grant: TrustedChannelGrant): () => void {
  const id = `openomni-resident-${grant.surface}`;
  ChannelGrantStore.put({
    id,
    surface: grant.surface,
    kind: "trusted_channel",
    defaultTier: grant.defaultTier,
    // An allowlisted grant materializes this tier for the listed senders
    // alone — everyone else on the surface finds no grant and is blocked.
    ...(grant.allowedSenders === undefined ? {} : { allowedSenders: [...grant.allowedSenders] }),
    createdBy: "local-owner",
  });
  return () => {
    ChannelGrantStore.remove(id);
  };
}

/**
 * THE grant seam the composition root hands the channel supervisor (#931):
 * the surface's tier is whatever its desired row declared, and the configured
 * allowlist pins the grant to its listed senders (an unlisted surface keeps
 * the open posture). Owner authority cannot enter here — this function names
 * no tier of its own, so no mounted named surface can acquire one.
 */
export function createMountedChannelGrantRegistrar(
  allowedSendersBySurface: Readonly<Record<string, readonly string[]>> | undefined,
): (surfaceId: string, defaultTier: Actor.TrustTier) => () => void {
  return (surfaceId, defaultTier) => {
    const allowedSenders = allowedSendersBySurface?.[surfaceId];
    return registerTrustedChannelGrant({
      surface: surfaceId,
      defaultTier,
      ...(allowedSenders === undefined ? {} : { allowedSenders }),
    });
  };
}

export interface OutboundMessaging {
  readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  readonly budgets?: () => readonly Gateway.SocialBudget[];
}

export function createResidentGateway(
  deliver: (delivery: Gateway.Deliver) => Promise<Ingress.IngressResult>,
  messaging?: OutboundMessaging,
): GatewayRouter {
  // The gateway owns only its own perimeter surface; external channel
  // components register (and revoke) their own authority when they mount.
  // The loopback ws bootstrap is the only surface that names owner tier; no
  // sibling surface inherits it.
  registerTrustedChannelGrant({ surface: "ws", defaultTier: LOOPBACK_BOOTSTRAP_TIER });
  return createGatewayRouter({
    sink: Bus.publish,
    deliver,
    ...(messaging === undefined
      ? {}
      : {
        messaging: {
          ...messaging,
          // Engaging the gate with an empty Owner-declared source makes
          // cold proactive outreach zero-by-default. Reply-scoped grants
          // bypass this budget axis in the send kernel.
          budgets: messaging.budgets ?? (() => []),
        },
      }),
  });
}
