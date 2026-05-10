import type { Guardrail, Message, Messenger, Policy, TraceContext } from "@openomni/protocol";
import type { AgentBudget, AgentEventEmitter, AgentStep, TokenUsage } from "../types";
import type { BudgetState } from "../budget";

export type PolicyVerdict = Policy.Verdict | Guardrail.EvaluationResult;

export interface PolicyContext<T = unknown> {
  timing: Policy.Timing;
  action?: string;
  resource?: string;
  input?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  resourceMeta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  data?: T;
  tools?: readonly string[];
  agentType?: string;
  traceContext?: TraceContext.Type;
  envelope?: Messenger.MessageEnvelope;
  steps?: AgentStep[];
  usage?: TokenUsage;
  turnCount?: number;
  isCompletion?: boolean;
  continuationCount?: number;
  elapsedMs?: number;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  messages?: Message.WithParts[];
  budgetState?: BudgetState;
  eventEmitter?: AgentEventEmitter;
  budget?: AgentBudget;
}

export type PolicyFn<T = unknown> = (
  ctx: PolicyContext<T>,
) => Promise<PolicyVerdict> | PolicyVerdict;

export interface PolicyRegistration<T = unknown> extends Policy.Definition {
  fn: PolicyFn<T>;
  propagate?: boolean;
}

export interface PolicySystemPromptVerdict {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
}

export interface PolicyEngineInstance {
  register<T = unknown>(policy: PolicyRegistration<T>): PolicyEngineInstance;
  freeze(): PolicyEngineInstance;
  dispatch<T = unknown>(
    timing: Policy.Timing,
    ctx: Omit<PolicyContext<T>, "timing">,
  ): Promise<PolicyVerdict>;
  dispatchSystemPrompt<T = unknown>(
    ctx: Omit<PolicyContext<T>, "timing">,
  ): Promise<PolicySystemPromptVerdict>;
  evaluatePermission(
    permission: Policy.Permission | undefined,
    request: Policy.EvaluationRequest,
  ): Guardrail.EvaluationResult;
  deriveChildPolicies(): PolicyRegistration[];
}
