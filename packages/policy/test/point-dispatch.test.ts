import { describe, expect, mock, test } from "bun:test";
import { composeEffects } from "../src/effects/compose";
import { createPolicyEngine } from "../src/engine/dispatch";

const PolicyEngine = { create: createPolicyEngine };
import { type Policy, PolicyDecision } from "@openomni/protocol";
import { atPoint, dispatchContext } from "./point-test-fixtures";

describe("PolicyEngine dispatchPoint selection", () => {
  test("passes an immutable canonical context to matching registrations", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    let observedPointId: string | undefined;
    let observedTiming: Policy.Timing | undefined;
    let observedMarker: string | undefined;
    let frozen = false;

    engine.add({
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

  test("selects only the requested point and preserves stable priority order", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const order: string[] = [];
    for (const [name, priority] of [
      ["first", 10],
      ["second", 10],
      ["later", 20],
    ] as const) {
      engine.add({
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
    engine.add({
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

  test("pins the agent type that selected a scoped registration into its context", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    let agentTypeReads = 0;
    let observedAgentType: unknown;
    engine.add({
      kind: "point",
      name: "resident-only",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      scope: { agentType: ["resident"] },
      fn: (ctx) => {
        observedAgentType = Reflect.get(ctx, "agentType");
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
    // A context getter cannot answer the selector and the selected policy
    // differently: the engine pins the value it selected on.
    expect(observedAgentType).toBe("resident");
  });

  test("keeps point selection isolated with no legacy dispatch member", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const invocations: string[] = [];
    engine.add({
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
    engine.add({
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
    const decision = await PolicyEngine.create({ clock: Date.now }).dispatchPoint(
      "dispatch.action.pre",
      dispatchContext,
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.policyId).toBe("agent.policy.composed");
    expect(decision.effects).toEqual([]);
  });

  test("dispatches run errors with canonical context", async () => {
    const onError = mock((_context) =>
      PolicyDecision.deny({
        policyId: "test.on-error",
        reasonCodes: ["test-error-abort"],
        effects: [{ type: "run.abort", reason: "test-error-abort" }],
      }),
    );
    const engine = PolicyEngine.create({ clock: Date.now });
    engine.add(
      atPoint("run.error.error", {
        name: "test:error",
        priority: 100,
        effects: ["run.abort"],
        fn: onError,
      }),
    );

    const verdict = await engine.dispatchPoint("run.error.error", {
      sessionId: "session",
      runId: "run",
      errorCode: "test-error",
      errorPhase: "turn",
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(verdict.verdict).toBe("deny");
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      timing: "error",
      errorCode: "test-error",
      errorPhase: "turn",
    });
  });
});

describe("tool.filter / tool.require_approval conflict rule", () => {
  test("does not self-conflict when a single policy emits both", () => {
    const composed = composeEffects([
      PolicyDecision.allow({
        policyId: "gatekeeper",
        priority: 0,
        effects: [
          { type: "tool.filter", toolPattern: "fs.*" },
          { type: "tool.require_approval", reason: "workspace write" },
        ],
      }),
    ]);

    expect(composed.verdict).toBe("allow");
    const types = composed.mergedEffects.map((effect) => effect.type);
    expect(types).toContain("tool.filter");
    expect(types).toContain("tool.require_approval");
  });

  test("stays fail-closed across policies regardless of priority", () => {
    const composed = composeEffects([
      PolicyDecision.allow({
        policyId: "filterer",
        priority: 10,
        effects: [{ type: "tool.filter", toolPattern: "fs.*" }],
      }),
      PolicyDecision.allow({
        policyId: "approver",
        priority: 0,
        effects: [{ type: "tool.require_approval", reason: "human gate" }],
      }),
    ]);

    expect(composed.verdict).toBe("deny");
    expect(
      composed.mergedEffects.some(
        (effect) =>
          effect.type === "audit.annotate" &&
          effect.annotation.includes("policy.effect_conflict.fail_closed") &&
          effect.annotation.includes("filterer") &&
          effect.annotation.includes("approver"),
      ),
    ).toBe(true);
  });
});

describe("model.override conflict rule (#757 review F1)", () => {
  test("same-priority divergent overrides fail closed — never an alphabetical winner", () => {
    const composed = composeEffects([
      PolicyDecision.allow({
        policyId: "aa-budget",
        priority: 50,
        effects: [{ type: "model.override", provider: "cheap", id: "model-a" }],
      }),
      PolicyDecision.allow({
        policyId: "zz-residency",
        priority: 50,
        effects: [{ type: "model.override", provider: "eu", id: "model-b" }],
      }),
    ]);

    expect(composed.verdict).toBe("deny");
    expect(
      composed.mergedEffects.some(
        (effect) =>
          effect.type === "audit.annotate" &&
          effect.annotation.includes("policy.effect_conflict.fail_closed") &&
          effect.annotation.includes("model.override.model"),
      ),
    ).toBe(true);
  });

  test("same-priority IDENTICAL overrides compose — one intent, no conflict", () => {
    const composed = composeEffects([
      PolicyDecision.allow({
        policyId: "aa-budget",
        priority: 50,
        effects: [{ type: "model.override", provider: "cheap", id: "model-a" }],
      }),
      PolicyDecision.allow({
        policyId: "zz-mirror",
        priority: 50,
        effects: [{ type: "model.override", provider: "cheap", id: "model-a" }],
      }),
    ]);

    expect(composed.verdict).toBe("allow");
    const overrides = composed.mergedEffects.filter((effect) => effect.type === "model.override");
    expect(overrides).toEqual([{ type: "model.override", provider: "cheap", id: "model-a" }]);
  });

  test("a higher-priority override wins regardless of policy name order", () => {
    const composed = composeEffects([
      PolicyDecision.allow({
        policyId: "zz-low",
        priority: 10,
        effects: [{ type: "model.override", provider: "p", id: "low-model" }],
      }),
      PolicyDecision.allow({
        policyId: "aa-high",
        priority: 90,
        effects: [{ type: "model.override", provider: "p", id: "high-model" }],
      }),
    ]);

    expect(composed.verdict).toBe("allow");
    const overrides = composed.mergedEffects.filter((effect) => effect.type === "model.override");
    expect(overrides).toEqual([{ type: "model.override", provider: "p", id: "high-model" }]);
  });
});
