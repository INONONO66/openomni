import type { Hook, Middleware, Message, Messenger, TraceContext } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget, AgentEventEmitter } from "../types";
import type { BudgetState } from "../budget";

export interface PolicyContext {
  timing: Hook.Timing;
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
}

export type PolicyFn = (ctx: PolicyContext) => Promise<Hook.Verdict> | Hook.Verdict;

export interface PolicyRegistration {
  name: string;
  timing: Hook.Timing | Hook.Timing[];
  priority: number;
  scope?: Middleware.Scope;
  failPolicy?: Middleware.FailPolicy;
  fn: PolicyFn;
  propagate?: boolean;
}
