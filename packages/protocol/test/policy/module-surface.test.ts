import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Policy, PolicyDecision, RuntimeResource, policyKernelVersion } from "../../src/index.js";
import {
  Policy as PolicyIndex,
  PolicyDecision as PolicyDecisionIndex,
  RuntimeResource as RuntimeResourceIndex,
  policyKernelVersion as policyKernelVersionIndex,
} from "../../src/policy/index.js";

const expectedPolicyKeys = [
  "Label",
  "LabelEntry",
  "PermissionDecision",
  "InputRule",
  "Permission",
  "EvaluationRequest",
  "EvaluationResult",
  "evaluate",
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
  "PolicyPlan",
];

const expectedPolicyDecisionKeys = [
  "allow",
  "deny",
  "pending",
  "isBlocking",
  "reason",
  "fromEvaluation",
];

const expectedPolicyPointStaticKeys = [
  "version",
  "Id",
  "Contract",
  "RegistrySchema",
  "Registry",
  "InputSchemas",
  "MigrationMapping",
  "resolve",
];

const expectedRuntimeResourceKeys = [
  "schemaVersion",
  "Kind",
  "Source",
  "ActorType",
  "SessionType",
  "ActorDescriptor",
  "SessionDescriptor",
  "Descriptor",
  "createWorkerDescriptor",
  "createCredentialDescriptor",
  "createSessionDescriptor",
];

const acceptsRootDecision = (decision: Policy.PolicyDecision): PolicyIndex.PolicyDecision =>
  decision;
const acceptsPolicyIndexDecision = (decision: PolicyIndex.PolicyDecision): Policy.PolicyDecision =>
  decision;
const acceptsRootResource = (
  descriptor: RuntimeResource.Descriptor,
): RuntimeResourceIndex.Descriptor => descriptor;
const acceptsPolicyIndexResource = (
  descriptor: RuntimeResourceIndex.Descriptor,
): RuntimeResource.Descriptor => descriptor;

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
    expect(RuntimeResource.Descriptor).toBe(RuntimeResourceIndex.Descriptor);
    expect(policyKernelVersion).toBe(policyKernelVersionIndex);
  });

  test("locks the public policy namespace keys", () => {
    expect(Object.keys(Policy)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyIndex)).toEqual(expectedPolicyKeys);
    expect(Object.keys(PolicyDecision)).toEqual(expectedPolicyDecisionKeys);
    expect(Object.keys(PolicyDecisionIndex)).toEqual(expectedPolicyDecisionKeys);
    const policyPointKeys = Object.keys(Policy.PolicyPoint);
    expect(policyPointKeys).toEqual(Object.keys(PolicyIndex.PolicyPoint));
    const zodObjectKeys = new Set(Object.keys(z.object({})));
    const policyPointStaticKeys = policyPointKeys.filter((key) => !zodObjectKeys.has(key));
    expect(policyPointStaticKeys).toEqual(expectedPolicyPointStaticKeys);
    expect(Object.keys(RuntimeResource)).toEqual(expectedRuntimeResourceKeys);
    expect(Object.keys(RuntimeResourceIndex)).toEqual(expectedRuntimeResourceKeys);
  });
});
