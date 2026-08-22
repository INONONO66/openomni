import { createPolicyEngine } from "./engine/dispatch";

export { PolicyRegistrationError } from "./engine/registration";
export { evaluatePermission, decisionFromEvaluation } from "./permission-evaluate";
export type {
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyRegistrationFactoryGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  PolicyPointId,
} from "./engine/types";
export { DuplicatePolicyFactoryError, PolicyRegistry } from "./registry";
export type { PolicyRegistryInstance } from "./registry";
// composeEffects has no production consumer outside this package's engine,
// but it is a deliberate conformance seam: packages/agent's composition
// conformance suites exercise the merge semantics from the consumer side
// through this export.
export { composeEffects } from "./effects/compose";

export const PolicyEngine = { create: createPolicyEngine };
