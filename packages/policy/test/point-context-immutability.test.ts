import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision } from "@openomni/protocol";
import { dispatchContext } from "./point-test-fixtures";

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

describe("PolicyEngine canonical point context immutability", () => {
  test("rejects Map context before it can mutate across middleware", async () => {
    const engine = PolicyEngine.create();
    const invocations: string[] = [];
    for (const name of ["first-map-policy", "second-map-policy"] as const) {
      engine.register({
        kind: "point",
        name,
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        fn: (ctx) => {
          invocations.push(name);
          const mutable = Reflect.get(ctx, "mutable");
          if (mutable instanceof Map) mutable.set("owner", name);
          return PolicyDecision.allow({ policyId: name });
        },
      });
    }

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      ...dispatchContext,
      mutable: new Map([["owner", "original"]]),
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.input_invalid");
    expect(invocations).toEqual([]);
  });

  test("deeply freezes plain structured records and arrays", async () => {
    const engine = PolicyEngine.create();
    let deeplyFrozen = false;
    engine.register({
      kind: "point",
      name: "plain-structured-context-policy",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: (ctx) => {
        const nested = Reflect.get(ctx, "nested");
        const items =
          typeof nested === "object" && nested !== null ? Reflect.get(nested, "items") : undefined;
        const first = Array.isArray(items) ? items[0] : undefined;
        deeplyFrozen =
          Object.isFrozen(ctx) &&
          Object.isFrozen(nested) &&
          Object.isFrozen(items) &&
          Object.isFrozen(first);
        return PolicyDecision.allow({ policyId: "plain-structured-context-policy" });
      },
    });

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      ...dispatchContext,
      nested: { items: [{ value: "original" }] },
    });

    expect(decision.verdict).toBe("allow");
    expect(deeplyFrozen).toBe(true);
  });

  for (const testCase of [
    { name: "function", value: () => "mutable behavior" },
    { name: "typed-array", value: new Uint8Array([1, 2, 3]) },
    { name: "Set", value: new Set(["mutable"]) },
    { name: "Proxy", value: new Proxy({ value: "uncloneable" }, {}) },
    { name: "cyclic record", value: cyclic },
    { name: "non-plain object", value: new Date(0) },
  ]) {
    test(`returns input-invalid for ${testCase.name} context`, async () => {
      const engine = PolicyEngine.create();
      let invoked = false;
      engine.register({
        kind: "point",
        name: "unsupported-context-policy",
        pointIds: ["dispatch.action.pre"],
        effectCapabilities: { "dispatch.action.pre": [] },
        priority: 0,
        fn: () => {
          invoked = true;
          return PolicyDecision.allow({ policyId: "unsupported-context-policy" });
        },
      });

      const decision = await engine.dispatchPoint("dispatch.action.pre", {
        ...dispatchContext,
        unsupported: testCase.value,
      });

      expect(decision.verdict).toBe("deny");
      expect(decision.reasonCodes).toContain("policy.input_invalid");
      expect(invoked).toBe(false);
    });
  }
});
