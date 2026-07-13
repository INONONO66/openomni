import { createPolicyEngine } from "./dispatch";

export type {
  PolicyAuditConfig,
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyEngineRegistrationGeneric,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  AuditDispatchContextGeneric,
  AuditEmit,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration";

export { createPolicyEngine };

export const PolicyEngine = { create: createPolicyEngine };
