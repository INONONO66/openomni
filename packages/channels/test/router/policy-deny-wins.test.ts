import { describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { IngressAuthorityMiddleware } from "../../src/router/authority.js";

// Split from openomni test/policy/policy-deny-wins.test.ts at the #707 seam
// flip: this is the ingress arm of the cross-middleware deny-wins property —
// the perimeter authority deny aborts the pipeline before anything brain-side
// (worker middleware, tool runtime) could allow. The brain-side arms stayed
// in openomni's policy-deny-wins suite.

function makeInboundEvent(overrides?: Partial<Gateway.DeliveredEvent>): Gateway.DeliveredEvent {
  return {
    id: "evt-1",
    traceId: "trace-test",
    surface: "test",
    mode: "direct",
    ...overrides,
  } as Gateway.DeliveredEvent;
}

describe("cross-middleware deny-wins (ingress arm)", () => {
  test("ingress deny blocks entire pipeline regardless of downstream allowances", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "actor is not authorized to create top-level inbound work",
    );
  });
});
