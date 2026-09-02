import {
  type ChannelDeliveryRoute,
  ChannelProviders,
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
export function registerTrustedChannelGrant(
  surface: string,
  allowedSenders?: readonly string[],
): () => void {
  const id = `openomni-resident-${surface}`;
  ChannelGrantStore.put({
    id,
    surface,
    kind: "trusted_channel",
    defaultTier: "owner",
    // An allowlisted grant materializes owner tier for the listed senders
    // alone — everyone else on the surface finds no grant and is blocked.
    ...(allowedSenders === undefined ? {} : { allowedSenders: [...allowedSenders] }),
    createdBy: "local-owner",
  });
  return () => {
    ChannelGrantStore.remove(id);
  };
}

/**
 * Per-channel markdown renderers, keyed by the provider id the ActorEndpoint
 * carries. Built once from the shipped registry — the gateway reads the same
 * `RenderPolicy` the surface will apply, so the #811 gate and the wire agree.
 */
const CHANNEL_RENDERERS: ReadonlyMap<string, (markdown: string) => string> = new Map(
  Object.values(ChannelProviders).map((provider) => [
    provider.id,
    provider.capabilities.render.renderMarkdown,
  ]),
);

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
    // #811: the router's egress secret gate sees what the channel would
    // actually put on the wire. Surfaces without a dialect transform (ws)
    // resolve to undefined and are gated on the raw body alone.
    renderFor: (channel) => CHANNEL_RENDERERS.get(channel),
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
