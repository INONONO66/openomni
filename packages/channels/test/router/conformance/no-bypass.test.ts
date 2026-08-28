import { beforeEach, describe, expect, it } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { ChannelGrantStore } from "@openomni/ledger";
import { deliveries, kernelRouter, resetRouterState } from "../_router-fixture";

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
  resetRouterState();
  ChannelGrantStore.put({
    id: "grant-internal",
    surface: "internal",
    kind: "trusted_channel",
    createdBy: "act_owner",
  });
});

describe("policy no-bypass conformance — gateway governed paths", () => {
  it("blocks unauthorized ingress before delivering to the brain", async () => {
    const error = await catchError(kernelRouter().ingest(unauthorizedInboundEvent()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "actor is not authorized to create top-level inbound work",
    );
    expect(deliveries).toHaveLength(0);
  });
});
