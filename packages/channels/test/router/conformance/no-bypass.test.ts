import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createGatewayRouter } from "../../../src/router/index.js";

// The no-bypass property at the flipped seam (#707): an unauthorized inbound
// principal is blocked by the gateway router BEFORE the brain's Deliver port
// is ever invoked. The pre-flip openomni conformance test pinned the same
// property as "blocked before dispatching to the coordinator"; the brain
// (and its coordinator) now sits behind ports.deliver, so a delivery count
// of zero is the equivalent, honest gate — nothing openomni-side can run for
// an event the perimeter refused.

// An admitted event whose actor is not authorized to create top-level inbound
// work. The channel grant is a trusted_channel with no defaultTier, so routing
// does not materialize a trust tier for the actor — it reaches the authority
// boundary as an un-elevated principal.
function unauthorizedInboundEvent(): Gateway.DeliveredEvent {
  return {
    id: "event-no-bypass",
    traceId: "trace-test",
    surface: "internal",
    workspace: "/repo",
    mode: "direct",
    payload: "spawn top-level work",
    meta: { actor: { role: "sub_persona", trusted: false } },
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-internal",
    surface: "internal",
    kind: "trusted_channel",
    createdBy: "act_owner",
  });
});

afterEach(() => {
  Bus.reset();
  Storage.reset();
});

describe("policy no-bypass conformance — gateway governed paths", () => {
  it("blocks unauthorized ingress before delivering to the brain", async () => {
    const deliveries: Gateway.Deliver[] = [];
    const router = createGatewayRouter({
      sink: (event, data) => {
        Bus.publish(event, data);
      },
      deliver: async (delivery) => {
        deliveries.push(delivery);
        return {
          mode: "direct",
          target: { kind: "resident" },
          sessionId: delivery.sessionId ?? "unrouted-session",
          result: { output: "should not deliver", finishReason: "stop" },
        };
      },
    });

    const error = await catchError(router.ingest(unauthorizedInboundEvent()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "actor is not authorized to create top-level inbound work",
    );
    expect(deliveries).toHaveLength(0);
  });
});
