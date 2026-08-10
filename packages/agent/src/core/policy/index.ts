export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyRegistration,
} from "./types";
export type { PolicyDecision, PolicyAuditConfig, PolicyEngineConfig } from "@openomni/policy";
export { PolicyRegistry, defaultRegistry } from "./registry";
export type { PolicyFactory, PolicyRegistryInstance } from "./registry";
export * from "./builtin";

import {
  PolicyEngine as GenericPolicyEngine,
  PolicyRegistrationError,
  type PolicyEngineConfig,
  type DispatchContextGeneric,
  type PolicyEngineInstanceGeneric,
} from "@openomni/policy";
import type { PolicyContext, PolicyEngineRegistration } from "./types";

function isCanonicalShape(registration: object): boolean {
  return (
    Reflect.get(registration, "kind") !== undefined ||
    Reflect.get(registration, "pointIds") !== undefined ||
    Reflect.get(registration, "effectCapabilities") !== undefined
  );
}

/**
 * Fail-closed registration boundary (#530): the agent engine accepts only
 * canonical point registrations. A timing-based (legacy) shape is rejected
 * with a typed error instead of being accepted-then-skipped at dispatch,
 * which would be a silent policy bypass.
 */
function rejectLegacyShape(registration: PolicyEngineRegistration): void {
  const shape: unknown = registration;
  if (typeof shape === "object" && shape !== null && isCanonicalShape(shape)) {
    return;
  }
  const name = typeof shape === "object" && shape !== null ? Reflect.get(shape, "name") : undefined;
  throw new PolicyRegistrationError({
    code: "legacy_timing_registration",
    registrationName: typeof name === "string" ? name : "<unknown>",
  });
}

export const PolicyEngine = {
  create(options: PolicyEngineConfig = {}) {
    const engine = GenericPolicyEngine.create<PolicyContext>(options);
    return {
      register(registration: PolicyEngineRegistration): void {
        rejectLegacyShape(registration);
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
