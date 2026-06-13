import type { Message, TraceContext, Policy } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget, AgentEventEmitter } from "../types";
import type { BudgetState } from "../budget";

export interface PolicyContext {
  timing: Policy.Timing;
  steps: AgentStep[];
  usage: TokenUsage;
  turnCount: number;
  isCompletion: boolean;
  continuationCount: number;
  elapsedMs: number;
  toolName?: string;
  toolCallId?: string;
  toolLabels?: string[];
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  messages?: Message.WithParts[];
  agentType?: string;
  budgetState?: BudgetState;
  eventEmitter?: AgentEventEmitter;
  budget?: AgentBudget;
  traceContext?: TraceContext.Type;
  labels?: Policy.LabelEntry[];
}

export type PolicyFn = (
  ctx: PolicyContext,
) => Promise<Policy.PolicyDecision> | Policy.PolicyDecision;

export interface PolicyRegistration {
  name: string;
  timing: Policy.Timing | Policy.Timing[];
  priority: number;
  scope?: Policy.Scope;
  failPolicy?: Policy.FailPolicy;
  fn: PolicyFn;
  propagate?: boolean;
}
