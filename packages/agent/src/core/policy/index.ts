export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyRegistration,
} from "./types";
export { PolicyEngine } from "./engine";
export type { PolicyDecision, PolicyAuditConfig, PolicyEngineConfig } from "@openomni/policy";
export { PolicyRegistry, defaultRegistry } from "./registry";
export type { PolicyFactory, PolicyRegistryInstance } from "./registry";
export * from "./builtin";

import type { PolicyContext, PolicyEngineRegistration } from "./types";
import type { DispatchContextGeneric, PolicyEngineInstanceGeneric } from "@openomni/policy";

/** Agent-scoped convenience alias: dispatch context typed to the full agent PolicyContext. */
export type DispatchContext = DispatchContextGeneric<PolicyContext>;

/** Agent-scoped convenience alias: engine instance typed to the full agent PolicyContext. */
export type PolicyEngineInstance = Omit<PolicyEngineInstanceGeneric<PolicyContext>, "register"> & {
  readonly register: (registration: PolicyEngineRegistration) => void;
};
