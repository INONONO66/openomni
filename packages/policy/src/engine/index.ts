import { createPolicyEngine } from "./dispatch";

export type {
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration";

export const PolicyEngine = { create: createPolicyEngine };
