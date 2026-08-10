import { describe, expect, test } from "bun:test";
import { composeEffects, mergeEntries, PolicyEngine } from "@openomni/policy";
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

  test("keeps generic run completion and canonical WorkItem completion independent", async () => {
    const timing = Policy.Timing.COMPLETION_PREPARE;
    const engine = PolicyEngine.create();
    let observedPointId: string | undefined;
    let observedTiming: Policy.Timing | undefined;
    engine.register({
      kind: "point",
      name: "work-completion-observer",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 0,
      fn: (ctx) => {
        observedPointId = ctx.pointId;
        observedTiming = ctx.timing;
        return PolicyDecision.allow({ policyId: "work-completion-observer" });
      },
    });

    const decision = await engine.dispatchPoint("work.complete.pre", {
      workItemHash: "wi_admission",
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 7,
      completionCandidate: { effectiveResultIds: ["result:publish"] },
      unresolvedBlockerIds: [],
    });

    expect(Policy.PolicyPoint.MigrationMapping[timing]).toEqual(["run.completion.pre"]);
    expect(Object.values(Policy.PolicyPoint.MigrationMapping).flat()).not.toContain(
      "work.complete.pre",
    );
    expect(decision.verdict).toBe("allow");
    expect(observedPointId).toBe("work.complete.pre");
    expect(observedTiming).toBe(timing);
  });

  test("resolves canonical timing after rejecting compatibility map mutation", async () => {
    const script = `
      import { Policy } from "@openomni/protocol";
      let mutationRejected = false;
      try {
        Policy.PolicyPoint.MigrationMapping[Policy.Timing.DISPATCH_AUTHORIZE] = ["run.lifecycle.pre"];
      } catch {
        mutationRejected = true;
      }
      if (!mutationRejected) process.exit(1);
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

  test("keeps point selection isolated with no legacy dispatch member", async () => {
    const engine = PolicyEngine.create();
    const invocations: string[] = [];
    engine.register({
      kind: "point",
      name: "action-policy",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => {
        invocations.push("action-policy");
        return PolicyDecision.allow({ policyId: "action-policy" });
      },
    });
    engine.register({
      kind: "point",
      name: "turn-policy",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 0,
      fn: () => {
        invocations.push("turn-policy");
        return PolicyDecision.allow({ policyId: "turn-policy" });
      },
    });

    // The legacy dispatch(timing) member was deleted in #530.
    expect(Reflect.get(engine, "dispatch")).toBeUndefined();
    await engine.dispatchPoint("dispatch.action.pre", dispatchContext);
    await engine.dispatchPoint("run.turn.pre", {
      sessionId: "session-1",
      runId: "run-1",
      turnIndex: 0,
    });

    expect(invocations).toEqual(["action-policy", "turn-policy"]);
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

describe("WorkItem policy effect composition", () => {
  test("retains the minimum source order when merging asserted-result allowances", () => {
    const merged = mergeEntries([
      {
        effect: { type: "work.allow_asserted", criterionIds: ["criterion:late"] },
        policyId: "late-asserted-allowance",
        priority: 0,
        decisionIndex: 0,
        effectIndex: 0,
        order: 10,
      },
      {
        effect: { type: "audit.annotate", annotation: "between" },
        policyId: "between",
        priority: 0,
        decisionIndex: 1,
        effectIndex: 0,
        order: 5,
      },
      {
        effect: { type: "work.allow_asserted", criterionIds: ["criterion:early"] },
        policyId: "early-asserted-allowance",
        priority: 0,
        decisionIndex: 2,
        effectIndex: 0,
        order: 1,
      },
    ]);

    expect(merged.effects).toEqual([
      { type: "work.allow_asserted", criterionIds: ["criterion:late", "criterion:early"] },
      { type: "audit.annotate", annotation: "between" },
    ]);
  });

  test("merges asserted-result allowances into one stable criterion list", () => {
    const later = PolicyDecision.allow({
      policyId: "later-asserted-allowance",
      priority: 10,
      effects: [
        {
          type: "work.allow_asserted",
          criterionIds: ["criterion:a", "criterion:c", "criterion:b"],
        },
      ],
    });
    const first = PolicyDecision.allow({
      policyId: "first-asserted-allowance",
      priority: 0,
      effects: [
        {
          type: "work.allow_asserted",
          criterionIds: ["criterion:b", "criterion:a"],
        },
      ],
    });

    const composed = composeEffects([later, first]);

    expect(composed.verdict).toBe("allow");
    expect(composed.mergedEffects).toEqual([
      {
        type: "work.allow_asserted",
        criterionIds: ["criterion:b", "criterion:a", "criterion:c"],
      },
    ]);
  });
});
