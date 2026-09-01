export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyRegistration,
  PolicyRegistrationFactory,
} from "./types";
import {
  PolicyEngine as GenericPolicyEngine,
  type PolicyEngineConfig,
  type DispatchContextGeneric,
  type PolicyEngineInstanceGeneric,
} from "@openomni/policy";
import type { PolicyContext } from "./types";

/** Agent-scoped convenience alias: dispatch context typed to the full agent PolicyContext. */
export type DispatchContext = DispatchContextGeneric<PolicyContext>;

/** Agent-scoped convenience alias: engine instance typed to the full agent PolicyContext. */
export type PolicyEngineInstance = PolicyEngineInstanceGeneric<PolicyContext>;

/**
 * The generic engine from @openomni/policy with the agent PolicyContext type
 * applied once. Same runtime object — the #498 W2 facade collapse deleted the
 * wrapper that used to re-implement `create()`/`register()` here; this is a
 * type binding, not a layer. Canonical-only since #530: the generic
 * registration boundary rejects timing-based (legacy) shapes fail-closed.
 */
export const PolicyEngine: {
  readonly create: (options: PolicyEngineConfig) => PolicyEngineInstance;
} = GenericPolicyEngine;
