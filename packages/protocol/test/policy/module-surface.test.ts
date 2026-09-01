import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Policy, PolicyDecision, PolicyPermission } from "../../src/index.js";
import {
  Policy as PolicyIndex,
  PolicyDecision as PolicyDecisionIndex,
  PolicyPermission as PolicyPermissionIndex,
} from "../../src/policy/index.js";

// #498 receipts: `evaluate` moved to @openomni/policy (evaluatePermission),
// `fromEvaluation` moved with it (decisionFromEvaluation), the RuntimeResource
// sibling folded into the namespace as Policy.Resource, and the test-only
// PolicyPoint.MigrationMapping compat surface was deleted.
const expectedPolicyKeys = [
  "LabelEntry",
  "InputRule",
  "Permission",
  "EvaluationRequest",
  "EvaluationResult",
  "Timing",
  "Scope",
  "FailPolicy",
  "Definition",
  "PolicyEffectType",
  "PolicyEffect",
  "PolicyObligation",
  "PolicyDecision",
  "EffectiveDecision",
  "PolicyPoint",
  "Resource",
  "PolicyPlan",
  // #499: observation descriptors converged under the noun namespace.
  "Events",
];

const expectedPolicyDecisionKeys = ["allow", "deny", "pending", "isBlocking", "reason"];

const expectedPolicyPointStaticKeys = [
  "version",
  "Id",
  "Contract",
  "RegistrySchema",
  "Registry",
  "InputSchemas",
];

const expectedResourceKeys = ["Source", "Descriptor"];

const acceptsRootDecision = (decision: Policy.PolicyDecision): PolicyIndex.PolicyDecision =>
  decision;
const acceptsPolicyIndexDecision = (decision: PolicyIndex.PolicyDecision): Policy.PolicyDecision =>
  decision;
const acceptsRootResource = (
  descriptor: Policy.Resource.Descriptor,
): PolicyIndex.Resource.Descriptor => descriptor;
const acceptsPolicyIndexResource = (
  descriptor: PolicyIndex.Resource.Descriptor,
): Policy.Resource.Descriptor => descriptor;

void acceptsRootDecision;
void acceptsPolicyIndexDecision;
void acceptsRootResource;
void acceptsPolicyIndexResource;

describe("policy module public surface", () => {
  test("root and policy barrels expose identical runtime policy symbols", () => {
    expect(Policy).toBe(PolicyIndex);
    expect(Policy.PolicyDecision).toBe(PolicyIndex.PolicyDecision);
    expect(Policy.PolicyPoint).toBe(PolicyIndex.PolicyPoint);
    expect(PolicyDecision.allow).toBe(PolicyDecisionIndex.allow);
    expect(Policy.Resource.Descriptor).toBe(PolicyIndex.Resource.Descriptor);
    expect(PolicyPermission.isSafeInputPattern).toBe(PolicyPermissionIndex.isSafeInputPattern);
  });

  test("locks the public policy namespace keys", () => {
    expect(Object.keys(Policy)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyIndex)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyDecision)).toEqual(expectedPolicyDecisionKeys);
    expect(Object.keys(PolicyDecisionIndex)).toEqual(expectedPolicyDecisionKeys);
    const policyPointKeys = Object.keys(Policy.PolicyPoint);
    expect(policyPointKeys).toEqual(Object.keys(PolicyIndex.PolicyPoint));
    // Zod 4.5 memoizes prototype-getter methods (e.g. `parse`) as own keys on
    // first access, so filter against the prototype chain, not own keys.
    const zodObjectProbe = z.object({});
    const policyPointStaticKeys = policyPointKeys.filter((key) => !(key in zodObjectProbe));
    expect(policyPointStaticKeys).toEqual(expectedPolicyPointStaticKeys);
    expect(Object.keys(Policy.Resource)).toEqual(expectedResourceKeys);
    expect(Object.keys(PolicyIndex.Resource)).toEqual(expectedResourceKeys);
  });

  test("shares the ReDoS-safety predicate with the moved evaluator (no duplication)", () => {
    expect(typeof PolicyPermission.isSafeInputPattern).toBe("function");
    expect(PolicyPermission.MAX_INPUT_LENGTH).toBe(10_000);
    expect(PolicyPermission.isSafeInputPattern("^true$")).toBe(true);
    expect(PolicyPermission.isSafeInputPattern("(")).toBe(false);
    // Deliberately-evil fixture proving the guard REJECTS exponential
    // backtracking. Assembled from parts so static scanners don't treat the
    // literal as a live regex source (the guard itself never executes it —
    // hasUnsafeQuantifier rejects before any .test()).
    const exponentialBacktracking = ["(a", "+)", "+b"].join("");
    expect(PolicyPermission.isSafeInputPattern(exponentialBacktracking)).toBe(false);
  });
});
