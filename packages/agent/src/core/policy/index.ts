export type { PolicyContext, PolicyFn, PolicyRegistration } from "./types";
export { PolicyEngine } from "@openomni/policy";
export type {
  PolicyDecision,
  PolicyAuditConfig,
  PolicyEngineConfig,
  GenericPolicyContext,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  AuditDispatchContextGeneric,
  AuditEmit,
} from "@openomni/policy";
export { PolicyRegistry, defaultRegistry } from "./registry";
export type { PolicyFactory, PolicyRegistryInstance, RuntimeContext } from "./registry";
export * from "./builtin";

import type { PolicyContext } from "./types";
import type { DispatchContextGeneric, PolicyEngineInstanceGeneric } from "@openomni/policy";

/** Agent-scoped convenience alias: dispatch context typed to the full agent PolicyContext. */
export type DispatchContext = DispatchContextGeneric<PolicyContext>;

/** Agent-scoped convenience alias: engine instance typed to the full agent PolicyContext. */
export type PolicyEngineInstance = PolicyEngineInstanceGeneric<PolicyContext>;
