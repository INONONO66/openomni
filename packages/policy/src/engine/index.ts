import { createPolicyEngine } from "./dispatch";
import { resolvePolicyPoints } from "./points";

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
export { resolvePolicyPoints };

export const PolicyEngine = { create: createPolicyEngine, resolvePolicyPoints };
