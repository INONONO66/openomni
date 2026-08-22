import { describe, expect, it } from "bun:test";
import { registerAt } from "../../helpers/policy-decision";
import { PolicyRegistrationError } from "@openomni/policy";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";

const allow = () => PolicyDecision.allow({ policyId: "test.allow" });

function pointCtx(): Record<string, unknown> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    sessionId: "session",
    runId: "run",
    turnIndex: 0,
  };
}

describe("agent policy registration fail-closed boundary (post-#530)", () => {
  it("rejects a timing-based registration with a typed fail-closed error", () => {
    const engine = PolicyEngine.create();

    expect(() =>
      engine.register({
        name: "legacy-timing",
        timing: "turn.start",
        priority: 0,
        fn: allow,
      } as never),
    ).toThrow(PolicyRegistrationError);
    try {
      engine.register({
        name: "legacy-timing",
        timing: "turn.start",
        priority: 0,
        fn: allow,
      } as never);
      throw new Error("expected register() to reject the timing-based registration");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyRegistrationError);
      expect((err as PolicyRegistrationError).code).toBe("legacy_timing_registration");
      expect((err as PolicyRegistrationError).registrationName).toBe("legacy-timing");
    }
  });

  it("rejects a multi-timing registration with the same typed error", () => {
    const engine = PolicyEngine.create();

    expect(() =>
      engine.register({
        name: "legacy-multi-timing",
        timing: ["turn.start", "turn.finish"],
        priority: 0,
        fn: allow,
      } as never),
    ).toThrow(PolicyRegistrationError);
  });

  it("does not silently skip a rejected registration at dispatch", async () => {
    const engine = PolicyEngine.create();
    try {
      engine.register({
        name: "legacy-timing",
        timing: "turn.start",
        priority: 0,
        fn: allow,
      } as never);
    } catch {
      // rejection is the pin; dispatch below must see an empty grid, not a
      // half-registered policy
    }

    const decision = await engine.dispatchPoint("run.turn.pre", pointCtx() as never);
    expect(decision.verdict).toBe("allow");
    expect(decision.policyId).toBe("agent.policy.composed");
  });

  it("still accepts canonical point registrations", async () => {
    const engine = PolicyEngine.create();
    const called: string[] = [];
    registerAt(engine, "run.turn.pre", "canonical", 0, () => {
      called.push("canonical");
      return allow();
    });

    const decision = await engine.dispatchPoint("run.turn.pre", pointCtx() as never);
    expect(decision.verdict).toBe("allow");
    expect(called).toEqual(["canonical"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -10],
    ["fractional", 0.5],
  ])("rejects a %s priority at the canonical registration boundary", (_label, priority) => {
    // The legacy store accepted arbitrary numeric priorities (NaN fell back
    // to registration order, ±Infinity sorted to the extremes). The canonical
    // boundary only admits non-negative integers and rejects the rest
    // fail-closed.
    const engine = PolicyEngine.create();
    expect(() =>
      engine.register({
        kind: "point",
        name: "non-finite-priority",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority,
        fn: allow,
      }),
    ).toThrow(PolicyRegistrationError);
  });

  it("preserves priority ordering and registration-order ties for point registrations", async () => {
    const registrations = [
      { name: "high", priority: 1000 },
      { name: "zero", priority: 0 },
      { name: "zero-second", priority: 0 },
      { name: "five", priority: 5 },
    ] as const;
    const firstOrder: string[] = [];
    const secondOrder: string[] = [];
    const firstEngine = PolicyEngine.create();
    const secondEngine = PolicyEngine.create();
    for (const registration of registrations) {
      firstEngine.register({
        kind: "point",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        ...registration,
        fn: () => {
          firstOrder.push(registration.name);
          return allow();
        },
      });
      secondEngine.register({
        kind: "point",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        ...registration,
        fn: () => {
          secondOrder.push(registration.name);
          return allow();
        },
      });
    }

    await firstEngine.dispatchPoint("run.turn.pre", pointCtx() as never);
    await secondEngine.dispatchPoint("run.turn.pre", pointCtx() as never);

    // Deterministic across engines: identical insertion order must produce an
    // identical execution order (equal priorities keep registration order).
    expect(secondOrder).toEqual(firstOrder);
    expect(firstOrder).toEqual(["zero", "zero-second", "five", "high"]);
  });
});
