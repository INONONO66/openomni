import { describe, expect, test } from "bun:test";
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
// #1246: the unconsumed interception-point contracts, Timing values, the
// plan/obligation schemas, and the four unobserved policy events were deleted.
const expectedPolicyKeys = [
  "Permission",
  "EvaluationRequest",
  "EvaluationResult",
  "PolicyEffect",
  "PolicyDecision",
  "Resource",
];

const expectedPolicyDecisionKeys = ["allow", "deny", "pending", "reason"];

const expectedResourceKeys = ["Descriptor"];

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
    expect(PolicyDecision.allow).toBe(PolicyDecisionIndex.allow);
    expect(Policy.Resource.Descriptor).toBe(PolicyIndex.Resource.Descriptor);
    expect(PolicyPermission.isSafeInputPattern).toBe(PolicyPermissionIndex.isSafeInputPattern);
  });

  test("locks the public policy namespace keys", () => {
    expect(Object.keys(Policy)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyIndex)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyDecision)).toEqual(expectedPolicyDecisionKeys);
    expect(Object.keys(PolicyDecisionIndex)).toEqual(expectedPolicyDecisionKeys);
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
