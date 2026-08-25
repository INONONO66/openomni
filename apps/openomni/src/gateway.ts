import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
} from "@openomni/channels";
import { ChannelGrantStore } from "@openomni/ledger";
import type { Gateway, Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

const CHANNEL_SURFACES = ["ws", "discord", "telegram", "github"] as const;
type ChannelSurface = (typeof CHANNEL_SURFACES)[number];

export interface OutboundMessaging {
  readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  readonly budgets?: () => readonly Gateway.SocialBudget[];
}

export function createResidentGateway(
  deliver: (delivery: Gateway.Deliver) => Promise<Ingress.IngressResult>,
  messaging?: OutboundMessaging,
  surfaces: readonly ChannelSurface[] = ["ws"],
): GatewayRouter {
  for (const surface of surfaces) {
    ChannelGrantStore.put({
      id: `openomni-resident-${surface}`,
      surface,
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "local-owner",
    });
  }
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
