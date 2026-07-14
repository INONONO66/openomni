import { createPolicyEngine } from "./dispatch";

export type {
  PolicyAuditConfig,
  PolicyDecision,
  PolicyEngineConfig,
  PolicyEngineCompatibilityGeneric,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyEngineRegistrationGeneric,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  DispatchPointContextGeneric,
  AuditDispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  AuditEmit,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration";

export const PolicyEngine = { create: createPolicyEngine };
