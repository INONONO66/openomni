export { PolicyEngine, PolicyRegistrationError } from "./engine";
export type {
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyRegistrationFactoryGeneric,
  PolicyEngineMiddlewareGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  PolicyPointId,
} from "./engine";
export { PolicyRegistry } from "./registry";
export type { PolicyRegistryInstance } from "./registry";
// composeEffects has no production consumer outside this package's engine,
// but it is a deliberate conformance seam: packages/agent's composition
// conformance suites exercise the merge semantics from the consumer side
// through this export. mergeEntries lost its barrel ride in the #606
// re-audit (its only external reader was this package's own test, which now
// deep-imports src/effects).
export { composeEffects } from "./effects";
