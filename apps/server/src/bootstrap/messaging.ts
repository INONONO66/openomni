import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import {
  createExistingAgentMessaging,
  type DeliveryReceipt,
  type ExistingAgentMessaging,
  type SenderTargetGrant,
} from "@openomni/openomni/messaging";

/**
 * Concrete production delivery owner for existing-agent messaging (#215).
 *
 * The messaging kernel resolves a target to exactly one ActorEndpoint and
 * hands this owner the resolved (channel, externalId) address; the owner maps
 * it to the registered channel surface's delivery method and reports the
 * platform message id when the channel API returns one (Discord and Telegram
 * do). A channel without a registered delivery surface is a hard delivery
 * failure — never a silent skip — matching the kernel's injected-owner
 * fail-closed rule.
 *
 * Grants come from bootstrap config (`messaging.grants`) and default to an
 * EMPTY list: with no explicitly configured sender-target grant, every send
 * is denied `ungranted`.
 */

export type ChannelDeliveryRoute = (externalId: string, body: string) => Promise<DeliveryReceipt>;

let composed: ExistingAgentMessaging | undefined;

/** Composes the messaging kernel over the channel delivery owner and registers it as the server's send seam. */
export function registerServerMessaging(input: {
  readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
  readonly grants: readonly SenderTargetGrant[];
  /** The boot's trace — registration is mid-boot, not a trace origin. */
  readonly traceId: string;
}): void {
  composed = createExistingAgentMessaging({
    deliver: async (message) => {
      const route = input.deliveryRoutes.get(message.target.channel);
      if (route === undefined) {
        throw new Error(
          `no registered channel surface delivers ${message.target.channel} ` +
            `(endpoint ${message.target.endpointId}) — delivery fails closed`,
        );
      }
      return route(message.target.externalId, message.body);
    },
    grants: () => input.grants,
  });
  Bus.publish(Operational.Events.Info, {
    traceId: input.traceId,
    time: Date.now(),
    component: "server",
    msg: "existing-agent messaging delivery owner registered",
    context: {
      channels: [...input.deliveryRoutes.keys()],
      grantsConfigured: input.grants.length,
    },
  });
}

/**
 * The server's existing-agent send seam (precedent: the api/a2a entry seam on
 * DefaultDispatchRuntime from #490 — deliberate seam, no HTTP surface yet).
 * Unregistered access keeps the typed injected-owner failure: nothing can
 * send around a missing owner.
 */
export function serverMessaging(): ExistingAgentMessaging {
  if (composed === undefined) {
    throw new Error("existing-agent messaging is not registered — sends fail closed");
  }
  return composed;
}
