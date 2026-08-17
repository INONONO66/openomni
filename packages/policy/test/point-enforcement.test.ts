import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { type Policy, PolicyDecision } from "@openomni/protocol";
import { dispatchContext } from "./point-test-fixtures";

function assertDispatchPointRequiresPointInput(engine: ReturnType<typeof PolicyEngine.create>) {
  // @ts-expect-error dispatch.action.pre requires every field in its PolicyPointInputMap entry.
  void engine.dispatchPoint("dispatch.action.pre", {
    sessionId: "session-1",
    runId: "run-1",
  });
  // @ts-expect-error tool.native.pre requires toolId.
  void engine.dispatchPoint("tool.native.pre", {
    sessionId: "session-1",
    runId: "run-1",
    toolInput: {},
  });
}
void assertDispatchPointRequiresPointInput;

const workCompletionContext = {
  workItemHash: "wi_admission",
  requestId: "request:completion",
  contractRevision: "contract:v1",
  basisRef: "basis:v1",
  expectedHead: 7,
  completionCandidate: { effectiveResultIds: ["result:publish"] },
  unresolvedBlockerIds: ["blocker:effect-pending"],
  resourceDescriptor: {
    id: "work:wi_admission",
    kind: "work" as const,
    labels: [],
    capabilities: [],
    effects: [],
  },
} satisfies Policy.PolicyPointInputMap["work.complete.pre"];

describe("PolicyEngine dispatchPoint", () => {
  test("rejects an invalid policy point ID with PolicyPointTimingError", async () => {
    const engine = PolicyEngine.create();

    await expect(
      Reflect.apply(engine.dispatchPoint, engine, ["unknown.point.pre", {}]),
    ).rejects.toMatchObject({
      name: "PolicyPointTimingError",
      message: "Registered policy point has no canonical timing: unknown.point.pre",
    });
  });

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
      target: undefined,
    } as unknown as Policy.PolicyPointInputMap["dispatch.action.pre"]);

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

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      sessionId: "session-1",
      runId: "run-1",
      runOutcome: { type: "unexpected" },
    } as unknown as Policy.PolicyPointInputMap["run.lifecycle.post"]);

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
      {
        failPolicy: "fail-open",
        verdict: "allow",
        // Fail-open keeps the allow, but the crash may not vanish: the
        // composed decision itself must carry the skipped policy's name.
        reason: "policy.middleware_failed.fail_open:throwing-policy",
      },
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
      expect(decision.reasonCodes).toEqual([testCase.reason]);
    }
  });

  test("records a fail-open middleware crash in the composed allow without auditEmit", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "crashing-guard",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      failPolicy: "fail-open",
      fn: () => {
        throw new Error("guard exploded");
      },
    });
    engine.register({
      kind: "point",
      name: "surviving-policy",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 1,
      fn: () => PolicyDecision.allow({ policyId: "surviving-policy" }),
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("policy.middleware_failed.fail_open:crashing-guard");
    const annotations = decision.effects.filter(
      (effect): effect is Extract<Policy.PolicyEffect, { type: "audit.annotate" }> =>
        effect.type === "audit.annotate",
    );
    expect(
      annotations.some((effect) =>
        effect.annotation.includes("policy.middleware_failed.fail_open:crashing-guard"),
      ),
    ).toBe(true);
  });

  test("re-attributes a spoofed middleware policyId to the invoked registration", async () => {
    const recorded: Policy.PolicyDecision[] = [];
    const engine = PolicyEngine.create({
      onDecision: (decision) => {
        recorded.push(decision);
      },
    });
    engine.register({
      kind: "point",
      name: "honest-name",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "some-other-policy" }),
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(decision.verdict).toBe("allow");
    // The engine knows which registration it invoked; a middleware cannot
    // claim another policy's identity for audit attribution.
    expect(recorded.map((entry) => entry.policyId)).toEqual(["honest-name"]);
  });

  test("keeps same-priority divergent writes fail-closed when one policy spoofs the other's id", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "spoofer",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          // Conflict rules exempt same-policyId writes; claiming the other
          // policy's id must not buy that exemption.
          policyId: "victim",
          effects: [{ type: "tool.rewrite_input", input: { path: "/spoofed" } }],
        }),
    });
    engine.register({
      kind: "point",
      name: "victim",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          policyId: "victim",
          effects: [{ type: "tool.rewrite_input", input: { path: "/legit" } }],
        }),
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      sessionId: "session-spoof",
      runId: "run-spoof",
      toolId: "tool-spoof",
      toolInput: {},
    });

    expect(decision.verdict).toBe("deny");
    expect(
      decision.effects.some(
        (effect) =>
          effect.type === "audit.annotate" &&
          effect.annotation.includes("policy.effect_conflict.fail_closed"),
      ),
    ).toBe(true);
  });

  test("keeps a WorkItem completion denial authoritative over asserted-result allowance", async () => {
    const pointId = "work.complete.pre";
    const allowAsserted = {
      type: "work.allow_asserted",
      criterionIds: ["criterion:publish"],
    } satisfies Policy.PolicyEffect;
    const engine = PolicyEngine.create();
    const evaluated: string[] = [];
    engine.register({
      kind: "point",
      name: "allow-low-asserted",
      pointIds: [pointId],
      effectCapabilities: { [pointId]: [allowAsserted.type] },
      priority: 0,
      fn: () => {
        evaluated.push("allow");
        return PolicyDecision.allow({
          policyId: "allow-low-asserted",
          effects: [allowAsserted],
        });
      },
    });
    engine.register({
      kind: "point",
      name: "block-unresolved-work",
      pointIds: [pointId],
      effectCapabilities: { [pointId]: [] },
      priority: 1,
      fn: () => {
        evaluated.push("deny");
        return PolicyDecision.deny({
          policyId: "block-unresolved-work",
          reasonCodes: ["work.completion_blocked"],
        });
      },
    });

    const decision = await engine.dispatchPoint(pointId, workCompletionContext);

    expect(evaluated).toEqual(["allow", "deny"]);
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("work.completion_blocked");
    expect(decision.effects.some((effect) => effect.type === "work.allow_asserted")).toBe(false);
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

  test("normalizes decision parser exceptions to invalid-decision denial", async () => {
    const engine = PolicyEngine.create();
    const throwingDecision = Object.defineProperty({}, "verdict", {
      enumerable: true,
      get() {
        throw new Error("malicious decision getter");
      },
    });
    Reflect.apply(engine.register, engine, [
      {
        kind: "point",
        name: "throwing-decision-getter",
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        fn: () => throwingDecision,
      },
    ]);

    const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.invalid_decision");
  });
});
