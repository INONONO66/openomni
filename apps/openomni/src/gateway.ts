import { createGatewayRouter, type GatewayRouter } from "@openomni/channels";
import { ChannelGrantStore } from "@openomni/ledger";
import type { Gateway, Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

const WEBSOCKET_GRANT_ID = "openomni-resident-websocket";

export function createResidentGateway(
  deliver: (delivery: Gateway.Deliver) => Promise<Ingress.IngressResult>,
): GatewayRouter {
  ChannelGrantStore.put({
    id: WEBSOCKET_GRANT_ID,
    surface: "ws",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "local-owner",
  });
  return createGatewayRouter({
    sink: Bus.publish,
    deliver,
  });
}
