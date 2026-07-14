import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision } from "@openomni/protocol";
import { dispatchContext } from "./point-test-fixtures";

describe("PolicyEngine dispatchPoint", () => {
  test("denies missing pre-boundary context before middleware runs", async () => {
    const engine = PolicyEngine.create();
    let invoked = false;
    engine.register({
      kind: "point",
      name: "must-not-run",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => {
        invoked = true;
        return PolicyDecision.allow({ policyId: "must-not-run" });
      },
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      ...dispatchContext,
      runId: undefined,
    });

    expect(invoked).toBe(false);
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.context_missing");
    expect(decision.effects.map((effect) => effect.type)).toEqual(["run.abort", "audit.annotate"]);
  });

  test("allows malformed post-boundary context with audit evidence before middleware runs", async () => {
    const engine = PolicyEngine.create();
    let invoked = false;
    engine.register({
      kind: "point",
      name: "post-observer",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": [] },
      priority: 0,
      fn: () => {
        invoked = true;
        return PolicyDecision.allow({ policyId: "post-observer" });
      },
    });

    const decision = await Reflect.apply(engine.dispatchPoint, engine, [
      "run.lifecycle.post",
      {
        sessionId: "session-1",
        runId: "run-1",
        runOutcome: { type: "unexpected" },
      },
    ]);

    expect(invoked).toBe(false);
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("policy.input_invalid");
    expect(decision.effects.map((effect) => effect.type)).toEqual(["audit.annotate"]);
  });

  test("rejects effects not declared by the canonical registration", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "undeclared-rewrite",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          policyId: "undeclared-rewrite",
          effects: [{ type: "tool.rewrite_input", input: { hidden: true } }],
        }),
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      sessionId: "session-1",
      runId: "run-1",
      toolId: "tool-1",
      toolInput: {},
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_declared");
    expect(decision.effects.some((effect) => effect.type === "tool.rewrite_input")).toBe(false);
  });

  test("parses middleware decisions once before enforcing declared effects", async () => {
    const engine = PolicyEngine.create();
    let effectReads = 0;
    const middlewareDecision = {
      policyId: "single-parse-policy",
      verdict: "allow",
      get effects() {
        effectReads += 1;
        return effectReads === 1 ? [{ type: "tool.rewrite_input", input: { hidden: true } }] : [];
      },
      reasonCodes: [],
    };
    Reflect.apply(engine.register, engine, [
      {
        kind: "point",
        name: "single-parse-policy",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
        priority: 0,
        fn: () => middlewareDecision,
      },
    ]);

    const decision = await engine.dispatchPoint("tool.native.pre", {
      sessionId: "session-single-parse",
      runId: "run-single-parse",
      toolId: "tool-single-parse",
      toolInput: {},
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_declared");
    expect(decision.effects.some((effect) => effect.type === "tool.rewrite_input")).toBe(false);
    expect(effectReads).toBe(1);
  });

  test("obeys fail-closed defaults and fail-open registration overrides", async () => {
    for (const testCase of [
      { failPolicy: undefined, verdict: "deny", reason: "middleware-error" },
      { failPolicy: "fail-open", verdict: "allow", reason: undefined },
    ] as const) {
      const engine = PolicyEngine.create();
      let invocationCount = 0;
      engine.register({
        kind: "point",
        name: "throwing-policy",
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        failPolicy: testCase.failPolicy,
        fn: () => {
          invocationCount += 1;
          throw new Error("policy failed");
        },
      });

      const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

      expect(invocationCount).toBe(1);
      expect(decision.verdict).toBe(testCase.verdict);
      expect(decision.reasonCodes).toEqual(testCase.reason === undefined ? [] : [testCase.reason]);
    }
  });

  test("denies invalid canonical middleware decisions deterministically", async () => {
    const engine = PolicyEngine.create();
    Reflect.apply(engine.register, engine, [
      {
        kind: "point",
        name: "invalid-decision",
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        fn: () => ({ verdict: "unexpected" }),
      },
    ]);

    const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
    expect(decision.reasonCodes).toContain("policy.invalid_decision");
    expect(decision.effects.map((effect) => effect.type)).toEqual(["run.abort", "audit.annotate"]);
  });
});
