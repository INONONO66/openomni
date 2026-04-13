import type { Hook, Middleware, Message } from "@openomni/protocol";
import type { AgentStep, TokenUsage, AgentBudget, AgentEventEmitter } from "../types";

export interface MiddlewareContext {
  timing: Hook.Timing;
  steps: AgentStep[];
  usage: TokenUsage;
  turnCount: number;
  isCompletion: boolean;
  continuationCount: number;
  elapsedMs: number;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  messages?: Message.WithParts[];
  agentType?: string;
  budgetState?: { turns: number; totalInputTokens: number; totalOutputTokens: number };
  eventEmitter?: AgentEventEmitter;
  budget?: AgentBudget;
}

export type MiddlewareFn = (ctx: MiddlewareContext) => Promise<Hook.Verdict> | Hook.Verdict;

export interface MiddlewareRegistration {
  name: string;
  timing: Hook.Timing | Hook.Timing[];
  priority: number;
  scope?: Middleware.Scope;
  failPolicy?: Middleware.FailPolicy;
  fn: MiddlewareFn;
}
