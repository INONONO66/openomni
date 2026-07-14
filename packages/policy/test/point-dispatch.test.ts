import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { Policy, PolicyDecision } from "@openomni/protocol";
import { dispatchContext } from "./point-test-fixtures";

describe("PolicyEngine dispatchPoint selection", () => {
  test("passes an immutable canonical context to matching registrations", async () => {
    const engine = PolicyEngine.create();
    let observedPointId: string | undefined;
    let observedTiming: Policy.Timing | undefined;
    let observedMarker: string | undefined;
    let frozen = false;

    engine.register({
      kind: "point",
      name: "dispatch-observer",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: (ctx) => {
        const marker = Reflect.get(ctx, "marker");
        observedPointId = ctx.pointId;
        observedTiming = ctx.timing;
        if (typeof marker === "object" && marker !== null) {
          const value = Reflect.get(marker, "value");
          observedMarker = typeof value === "string" ? value : undefined;
          frozen = Object.isFrozen(ctx) && Object.isFrozen(marker);
        }
        return PolicyDecision.allow({ policyId: "dispatch-observer" });
      },
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(decision.verdict).toBe("allow");
    expect(observedPointId).toBe("dispatch.action.pre");
    expect(observedTiming).toBe("dispatch.authorize");
    expect(observedMarker).toBe("original");
    expect(frozen).toBe(true);
  });

  test("keeps canonical timing stable after the public migration map is mutated", async () => {
    const timing = Policy.Timing.DISPATCH_AUTHORIZE;
    const originalMapping = Policy.PolicyPoint.MigrationMapping[timing];

    try {
      Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, ["run.lifecycle.pre"]);
      const engine = PolicyEngine.create();
      let observedTiming: Policy.Timing | undefined;
      engine.register({
        kind: "point",
        name: "stable-timing-observer",
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        fn: (ctx) => {
          observedTiming = ctx.timing;
          return PolicyDecision.allow({ policyId: "stable-timing-observer" });
        },
      });

      const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

      expect(decision.verdict).toBe("allow");
      expect(observedTiming).toBe(Policy.Timing.DISPATCH_AUTHORIZE);
    } finally {
      Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, originalMapping);
    }
  });

  test("resolves canonical timing when policy loads after compatibility map mutation", async () => {
    const script = `
      import { Policy } from "@openomni/protocol";
      Policy.PolicyPoint.MigrationMapping[Policy.Timing.DISPATCH_AUTHORIZE] = ["run.lifecycle.pre"];
      const { PolicyEngine } = await import("./src/index.ts");
      const decision = await PolicyEngine.create().dispatchPoint("dispatch.action.pre", {
        actor: { kind: "system", actorId: "system:test" },
        dispatchId: "dispatch-1",
        action: "resident.ask",
        target: { kind: "resident" },
        sessionId: "session-1",
        runId: "run-1",
      });
      if (decision.verdict !== "allow") process.exit(1);
    `;
    const child = Bun.spawn(["bun", "-e", script], {
      cwd: new URL("../", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });

  test("selects only the requested point and preserves stable priority order", async () => {
    const engine = PolicyEngine.create();
    const order: string[] = [];
    for (const [name, priority] of [
      ["first", 10],
      ["second", 10],
      ["later", 20],
    ] as const) {
      engine.register({
        kind: "point",
        name,
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority,
        fn: () => {
          order.push(name);
          return PolicyDecision.allow({ policyId: name });
        },
      });
    }
    engine.register({
      kind: "point",
      name: "other-point",
      pointIds: ["run.lifecycle.pre"],
      effectCapabilities: { "run.lifecycle.pre": [] },
      priority: 5,
      fn: () => {
        order.push("other-point");
        return PolicyDecision.allow({ policyId: "other-point" });
      },
    });

    await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(order).toEqual(["first", "second", "later"]);
  });

  test("selects scoped registrations from the immutable agent type snapshot", async () => {
    const engine = PolicyEngine.create();
    let agentTypeReads = 0;
    let invoked = false;
    engine.register({
      kind: "point",
      name: "resident-only",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      scope: { agentType: ["resident"] },
      fn: () => {
        invoked = true;
        return PolicyDecision.allow({ policyId: "resident-only" });
      },
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      ...dispatchContext,
      get agentType() {
        agentTypeReads += 1;
        return agentTypeReads === 1 ? "resident" : "worker";
      },
    });

    expect(decision.verdict).toBe("allow");
    expect(invoked).toBe(true);
    expect(agentTypeReads).toBe(1);
  });

  test("keeps legacy and canonical dispatch selection isolated", async () => {
    const engine = PolicyEngine.create();
    const invocations: string[] = [];
    engine.register({
      name: "legacy",
      timing: "dispatch.authorize",
      priority: 0,
      fn: () => {
        invocations.push("legacy");
        return PolicyDecision.allow({ policyId: "legacy" });
      },
    });
    engine.register({
      kind: "point",
      name: "canonical",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => {
        invocations.push("canonical");
        return PolicyDecision.allow({ policyId: "canonical" });
      },
    });

    await engine.dispatchPoint("dispatch.action.pre", dispatchContext);
    await engine.dispatch("dispatch.authorize", dispatchContext);

    expect(invocations).toEqual(["canonical", "legacy"]);
  });

  test("allows valid canonical dispatches with no matching registrations", async () => {
    const decision = await PolicyEngine.create().dispatchPoint(
      "dispatch.action.pre",
      dispatchContext,
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.policyId).toBe("agent.policy.composed");
    expect(decision.effects).toEqual([]);
  });
});
