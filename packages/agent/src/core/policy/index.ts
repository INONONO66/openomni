export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyRegistration,
} from "./types";
export { PolicyRegistry } from "@openomni/policy";
export type { PolicyRegistryInstance } from "@openomni/policy";

import {
  PolicyEngine as GenericPolicyEngine,
  type PolicyEngineConfig,
  type DispatchContextGeneric,
  type PolicyEngineInstanceGeneric,
} from "@openomni/policy";
import type { PolicyContext, PolicyEngineRegistration } from "./types";

export const PolicyEngine = {
  create(options: PolicyEngineConfig = {}) {
    const engine = GenericPolicyEngine.create<PolicyContext>(options);
    return {
      // Canonical-only since #530: the generic registration boundary rejects
      // timing-based (legacy) shapes fail-closed with a typed
      // PolicyRegistrationError (code legacy_timing_registration).
      register(registration: PolicyEngineRegistration): void {
        engine.register(registration);
      },
      dispatchPoint: engine.dispatchPoint,
    };
  },
} as const;

/** Agent-scoped convenience alias: dispatch context typed to the full agent PolicyContext. */
export type DispatchContext = DispatchContextGeneric<PolicyContext>;

/** Agent-scoped convenience alias: engine instance typed to the full agent PolicyContext. */
export type PolicyEngineInstance = Omit<
  PolicyEngineInstanceGeneric<PolicyContext>,
  "register" | "dispatch"
> & {
  readonly register: (registration: PolicyEngineRegistration) => void;
};
