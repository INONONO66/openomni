import { createPolicyEngine } from "./engine/dispatch";

export {
  compilePolicySnapshot,
  CORE_ACTION_KINDS,
  createPolicyCompiler,
  MANDATORY_RULE_NAMES,
  OBLIGATION_NAMES,
  PolicyCompileError,
  SEEDED_POLICY_ROWS,
  TRANSFORMER_NAMES,
} from "./row-compiler";
export type {
  CompiledObligation,
  CompiledPolicySnapshot,
  CompilePolicySnapshotOptions,
  CoreActionKind,
  EffectiveRowVerdict,
  ObligationName,
  PolicyCompileErrorCode,
  PolicyCompiler,
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyRowDraft,
  RuleName,
  TransformerName,
} from "./row-compiler";

export { PolicyRegistrationError } from "./engine/registration";
export { evaluatePermission, decisionFromEvaluation } from "./permission-evaluate";
export type {
  PolicyEngineConfig,
  GenericPolicyContext,
  CanonicalPolicyRegistrationGeneric,
  PolicyRegistrationFactoryGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  PolicyPointId,
} from "./engine/types";
// composeEffects has no production consumer outside this package's engine,
// but it remains a deliberate public conformance seam for policy-owned tests.
export { composeEffects } from "./effects/compose";

export const PolicyEngine = { create: createPolicyEngine };
