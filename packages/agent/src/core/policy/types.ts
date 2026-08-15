import type { Policy } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget } from "../types";
import type { BudgetState } from "../budget";
import type { CanonicalPolicyRegistrationGeneric, GenericPolicyContext } from "@openomni/policy";

export interface PolicyContext extends GenericPolicyContext {
  timing: Policy.Timing;
  /**
   * Optional at construction, but guaranteed non-empty on every canonical
   * dispatch: the run.turn.pre / run.completion.pre point contracts require
   * it and buildLifecyclePolicyContext stamps it on each dispatch context.
   */
  sessionId?: string;
  steps: AgentStep[];
  usage: TokenUsage;
  turnCount: number;
  isCompletion: boolean;
  continuationCount: number;
  elapsedMs: number;
  budgetState?: BudgetState;
  budget?: AgentBudget;
  /**
   * Provider-measured context of the last model call (input + both cache
   * lanes). What the compaction trigger compares against its window; absent
   * until a call completes.
   */
  contextTokens?: number;
  /**
   * The resolved model's context window, recorded by the loop — a fact, not
   * strategy. Config may still narrow it; it cannot need to restate it.
   */
  contextWindowTokens?: number;
  /**
   * True when this dispatch exists because the step loop yielded at the
   * window. The yield IS the trigger — a threshold gate here would let a
   * config ratio above the loop's arm point kill runs the seam never tried
   * to reclaim.
   */
  contextYielded?: boolean;
}

export type PolicyFn = CanonicalPolicyRegistrationGeneric<PolicyContext>["fn"];

export type CanonicalPolicyRegistration = CanonicalPolicyRegistrationGeneric<PolicyContext>;

/**
 * Canonical-only since #530: the agent engine no longer accepts timing-based
 * (legacy) registrations — `register()` rejects them fail-closed.
 */
export type PolicyRegistration = CanonicalPolicyRegistration;

export type PolicyEngineRegistration = CanonicalPolicyRegistration;
