import type {
  Hook,
  Middleware,
  Message,
  Messenger,
  TraceContext,
  Policy,
} from "@openomni/protocol";
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
  envelope?: Messenger.MessageEnvelope;
  labels?: Policy.LabelEntry[];
}

export type PolicyFn = (ctx: PolicyContext) => Promise<Hook.Verdict> | Hook.Verdict;

export interface PolicyRegistration {
  name: string;
  timing: Policy.Timing | Policy.Timing[];
  priority: number;
  scope?: Middleware.Scope;
  failPolicy?: Middleware.FailPolicy;
  fn: PolicyFn;
  propagate?: boolean;
}
