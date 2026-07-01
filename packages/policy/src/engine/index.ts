import { createPolicyEngine } from "./dispatch";

export type {
  PolicyAuditConfig,
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  AuditDispatchContextGeneric,
  AuditEmit,
  PolicyPointId,
} from "./types";

export { createPolicyEngine };

export const PolicyEngine = { create: createPolicyEngine };
