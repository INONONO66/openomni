import { describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine, PolicyRegistrationError } from "@openomni/policy";

const allow = () => PolicyDecision.allow({ policyId: "canonical.boundary.test" });

function registrationErrorFor(
  registration: Readonly<Record<string, unknown>>,
): PolicyRegistrationError {
  const engine = PolicyEngine.create();
  try {
    Reflect.apply(engine.register, engine, [registration]);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRegistrationError);
    if (error instanceof PolicyRegistrationError) return error;
    throw error;
  }
  throw new Error("Expected PolicyRegistrationError");
}

describe("PolicyEngine canonical registration boundary", () => {
  test("accepts complete canonical metadata", () => {
    const engine = PolicyEngine.create();

    expect(() =>
      engine.register({
        kind: "point",
        name: "complete-canonical",
        pointIds: ["run.lifecycle.post"],
        effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
        priority: 0,
        scope: { agentType: ["resident"] },
        failPolicy: "fail-closed",
        propagate: true,
        fn: allow,
      }),
    ).not.toThrow();
  });

  test("rejects malformed canonical metadata with typed errors", () => {
    const base = {
      kind: "point",
      name: "canonical-boundary",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      priority: 100,
      fn: allow,
    };
    const malformed = [
      { name: "" },
      { name: 1 },
      { priority: -1 },
      { priority: 1.5 },
      { fn: "not-a-function" },
      { scope: "resident" },
      { scope: { agentType: "resident" } },
      { scope: { agentType: ["resident", 1] } },
      { failPolicy: "ignore" },
      { propagate: "yes" },
    ];

    for (const override of malformed) {
      expect(registrationErrorFor({ ...base, ...override }).code).toBe(
        "invalid_canonical_registration",
      );
    }
  });
});
