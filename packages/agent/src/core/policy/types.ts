import type { Policy } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget, AgentEventEmitter } from "../types";
import type { BudgetState } from "../budget";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineRegistrationGeneric,
  PolicyRegistrationGeneric,
} from "@openomni/policy";

export interface PolicyContext extends GenericPolicyContext {
  timing: Policy.Timing;
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

export type PolicyFn = (
  ctx: PolicyContext,
) => Promise<Policy.PolicyDecision> | Policy.PolicyDecision;

/** Agent-scoped convenience alias: registration typed to the full agent PolicyContext. */
export type PolicyRegistration = PolicyRegistrationGeneric<PolicyContext>;

export type CanonicalPolicyRegistration = Omit<
  CanonicalPolicyRegistrationGeneric<PolicyContext>,
  "fn"
> & {
  readonly fn: PolicyFn;
};

export type PolicyEngineRegistration = PolicyEngineRegistrationGeneric<PolicyContext>;
