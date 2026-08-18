import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { ExistingAgentMessaging } from "@openomni/channels";

/**
 * Server registry for the existing-agent messaging kernel (#215).
 *
 * Since #707 stage 2 the send kernel itself lives in the gateway router
 * (`createGatewayRouter` composes it over the channel delivery routes and the
 * configured grants — same config source, apps/server/src/config.ts); this
 * module keeps only the server's fail-closed access seam and the boot
 * registration receipt.
 */
export type { ChannelDeliveryRoute } from "@openomni/channels";

let composed: ExistingAgentMessaging | undefined;

/** Registers the router-composed send kernel as the server's send seam and records the boot receipt. */
export function registerServerMessaging(input: {
  readonly messaging: ExistingAgentMessaging;
  readonly channels: readonly string[];
  readonly grantsConfigured: number;
  /** The boot's trace — registration is mid-boot, not a trace origin. */
  readonly traceId: string;
}): void {
  composed = input.messaging;
  Bus.publish(Operational.Events.Info, {
    traceId: input.traceId,
    time: Date.now(),
    component: "server",
    msg: "existing-agent messaging delivery owner registered",
    context: {
      channels: [...input.channels],
      grantsConfigured: input.grantsConfigured,
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
