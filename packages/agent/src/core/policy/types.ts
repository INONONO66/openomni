import type { Policy } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget, AgentEventEmitter } from "../types";
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
  eventEmitter?: AgentEventEmitter;
  budget?: AgentBudget;
}

export type PolicyFn = CanonicalPolicyRegistrationGeneric<PolicyContext>["fn"];

export type CanonicalPolicyRegistration = CanonicalPolicyRegistrationGeneric<PolicyContext>;

/**
 * Canonical-only since #530: the agent engine no longer accepts timing-based
 * (legacy) registrations — `register()` rejects them fail-closed.
 */
export type PolicyRegistration = CanonicalPolicyRegistration;

export type PolicyEngineRegistration = CanonicalPolicyRegistration;
