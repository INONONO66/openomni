import { expect, test } from "bun:test";
import {
  PolicyEngine,
  type GenericPolicyContext,
  type PolicyEngineRegistrationGeneric,
} from "@openomni/policy";
import { PolicyDecision } from "@openomni/protocol";

test("accepts union-typed registrations through the public engine overload", () => {
  const engine = PolicyEngine.create<GenericPolicyContext>();
  const registerUnion = (registration: PolicyEngineRegistrationGeneric<GenericPolicyContext>) =>
    engine.register(registration);

  expect(() =>
    registerUnion({
      kind: "point",
      name: "union-registration",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "union-registration" }),
    }),
  ).not.toThrow();
});
