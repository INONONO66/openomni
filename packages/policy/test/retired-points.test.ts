import { describe, expect, it } from "bun:test";
import { PolicyEngine, PolicyRegistrationError } from "../src";
import { Policy, PolicyDecision } from "@openomni/protocol";

/**
 * #530 points disposition: session.inbound.pre and session.writeback.pre
 * are protocol-declared vocabulary with zero consumers. Their contracts
 * cannot be honestly dispatched at the kernel ingress boundary (anonymous
 * actors are legal there; writebacks span zero or many runs), so the grid
 * retires them fail-closed until the protocol contract is redesigned.
 */
describe("retired policy points (post-#530)", () => {
  const retired = ["session.inbound.pre", "session.writeback.pre"] as const;

  it.each([...retired])("rejects registration at %s with a typed fail-closed error", (pointId) => {
    const engine = PolicyEngine.create();
    expect(() =>
      engine.register({
        kind: "point",
        name: "retired-registrant",
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => PolicyDecision.allow({ policyId: "retired-registrant" }),
      }),
    ).toThrow(PolicyRegistrationError);
    try {
      engine.register({
        kind: "point",
        name: "retired-registrant",
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => PolicyDecision.allow({ policyId: "retired-registrant" }),
      });
      throw new Error("expected registration at a retired point to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyRegistrationError);
      expect((err as PolicyRegistrationError).code).toBe("retired_point_id");
      expect((err as PolicyRegistrationError).pointId).toBe(pointId);
    }
  });

  it.each([...retired])("fails closed when dispatching %s", async (pointId) => {
    const engine = PolicyEngine.create();
    await expect(
      engine.dispatchPoint(pointId, {
        actorId: "actor",
        sessionId: "session",
        runId: "run",
        inboundEvent: { type: "message" },
        writebackPayload: "output",
      } as never),
    ).rejects.toThrow(`Registered policy point has no canonical timing: ${pointId}`);
  });

  it("keeps every non-retired protocol point registrable", () => {
    // The grid must retire exactly the two flagged points — nothing else.
    const gridMisses: string[] = [];
    for (const pointId of Object.keys(Policy.PolicyPoint.Registry)) {
      const engine = PolicyEngine.create();
      try {
        engine.register({
          kind: "point",
          name: "probe",
          pointIds: [pointId as never],
          effectCapabilities: { [pointId]: [] } as never,
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "probe" }),
        });
      } catch {
        gridMisses.push(pointId);
      }
    }
    expect(gridMisses.sort()).toEqual(["session.inbound.pre", "session.writeback.pre"]);
  });
});
