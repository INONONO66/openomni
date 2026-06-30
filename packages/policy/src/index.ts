/** Core policy engine for evaluating and dispatching policy decisions. */
export { PolicyEngine } from "./engine";
/** Types for policy engine configuration, context, registration, and audit. */
export type {
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  AuditDispatchContextGeneric,
  PolicyAuditConfig,
  AuditEmit,
  PolicyPointId,
} from "./engine-types";
/** Registry for managing policy factories and resolving policies from plans. */
export { PolicyRegistry } from "./registry";
/** Types for policy factories, registry instances, and runtime context. */
export type { PolicyFactory, PolicyRegistryInstance, RuntimeContext } from "./registry";
/** Utility for composing policy effects into ordered decisions. */
export { composeEffects } from "./effect-composition";
/** Types for effect composition results and conflict resolution. */
export type {
  OrderedDecision,
  EffectEntry,
  Conflict,
  MergeResult,
} from "./effect-composition-types";
/** Utility for merging effect entries with conflict detection. */
export { mergeEntries } from "./effect-merge-rules";
/** Types for effect accumulator sets. */
export type { EffectAccumulatorSet } from "./effect-merge-output";
