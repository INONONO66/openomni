import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
} from "@openomni/channels";
import { ChannelGrantStore } from "@openomni/ledger";
import type { Gateway, Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

/**
 * Registers the Resident's trusted-channel authority for one surface and
 * returns the revoker. A channel component holds this while mounted: the
 * grant exists exactly as long as the component serves the surface, so an
 * unmounted channel's inbound traffic loses `trusted_channel` treatment and
 * the perimeter refuses it fail-closed. Grants are current authority, not
 * history — revoking one erases no recorded fact.
 */
export function registerTrustedChannelGrant(surface: string): () => void {
  const id = `openomni-resident-${surface}`;
  ChannelGrantStore.put({
    id,
    surface,
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "local-owner",
  });
  return () => {
    ChannelGrantStore.remove(id);
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
  registerTrustedChannelGrant("ws");
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
