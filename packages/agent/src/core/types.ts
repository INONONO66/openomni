import type { Tool, Sink, Guardrail, Message, Hook } from "@openomni/protocol";
import type { Memory } from "./memory";
import type { MiddlewareRegistration } from "./middleware/types";
import type { AgentRuntimeContext } from "./runtime-context";

export type StepGuardVerdict =
  | { action: "continue" }
  | { action: "inject"; message: string; reason?: string; policyId?: string }
  | { action: "abort"; reason?: string; policyId?: string };

export interface StepGuardContext {
  steps: AgentStep[];
  usage: TokenUsage;
  turnCount: number;
  isCompletion: boolean;
  continuationCount: number;
  elapsedMs: number;
}

/**
 * @deprecated Use {@link MiddlewareContext} from `./middleware/types` instead.
 * Register middleware via `ChatAgentConfig.middleware` array.
 */
export interface HookContext {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: string;
  steps: AgentStep[];
  turnCount: number;
  elapsedMs: number;
}

/**
 * @deprecated Use {@link Hook.Verdict} from `@openomni/protocol` instead.
 * Register middleware via `ChatAgentConfig.middleware` array.
 */
export type HookVerdict = Hook.Verdict;

/**
 * @deprecated Use {@link MiddlewareRegistration} from `./middleware/types` instead.
 * Register middleware via `ChatAgentConfig.middleware` array.
 */
export interface ExecutionHooks {
  preToolUse?: (context: HookContext) => Promise<HookVerdict> | HookVerdict;
  postToolUse?: (context: HookContext) => Promise<HookVerdict> | HookVerdict;
  preTurn?: (context: HookContext) => Promise<HookVerdict> | HookVerdict;
  postTurn?: (context: HookContext) => Promise<HookVerdict> | HookVerdict;
  onError?: (context: HookContext & { error: Error }) => Promise<HookVerdict> | HookVerdict;
}

export interface AgentEventEmitter {
  emit(eventName: string, data: Record<string, unknown>): void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxToolRuntimeMs?: number;
  warningThreshold?: number; // 0.0-1.0, default 0.8
  reassuranceThreshold?: number; // 0.0-1.0, default 0.6
}

export interface ChatAgentConfig {
  systemPrompt?: string;
  tools?: Tool.Spec[];
  model: {
    provider: string;
    id: string;
  };
  budget?: AgentBudget;
  onStepFinish?: (step: AgentStep) => void | Promise<void>;
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  signal?: AbortSignal;
  permissions?: Guardrail.Permission;
  compaction?: {
    contextWindowTokens: number;
    thresholdRatio?: number;
    protectRecentMessages?: number;
    onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  };
  memory?: Memory;
  /**
   * @deprecated Use `middleware` array with `post_turn` timing instead.
   * Register a middleware with `timing: "post_turn"` to replace stepGuard behavior.
   */
  stepGuard?: (
    step: AgentStep,
    context: StepGuardContext,
  ) => Promise<StepGuardVerdict> | StepGuardVerdict;
  /**
   * @deprecated Use `middleware` array instead.
   * Register middleware via `ChatAgentConfig.middleware` for all hook behaviors.
   */
  hooks?: ExecutionHooks;
  eventEmitter?: AgentEventEmitter;
  providerOptions?: Record<string, unknown>;
  middleware?: MiddlewareRegistration[];
  context?: AgentRuntimeContext;
}

export interface ChatAgentInput {
  messages: Array<{ role: "user"; content: string } | { role: "assistant"; content: string }>;
  metadata?: Record<string, unknown>;
  traceContext?: import("@openomni/protocol").TraceContext.Type;
}

export interface AgentStep {
  type: "tool-call" | "text";
  content: string;
  toolCalls?: Tool.Call[];
  toolResults?: Tool.Result[];
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  usage: TokenUsage;
  finishReason: "stop" | "tool-calls" | "max-steps" | "handoff" | "stalled";
  handoffTarget?: string;
  compactionCount?: number;
  guardAborted?: boolean;
}

export type AgentEvent =
  | { type: "text_chunk"; text: string }
  | {
      type: "tool_call_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_call_complete"; toolCallId: string; result: Tool.Result }
  | { type: "turn_complete"; turnIndex: number; usage: TokenUsage }
  | { type: "error"; error: Error; willRetry: boolean }
  | { type: "complete"; result: AgentResult }
  | { type: "budget_warning"; remaining: string }
  | { type: "budget_reassurance"; remaining: string }
  | { type: "hook_verdict"; timing: Hook.Timing; action: HookVerdict["action"]; reason?: string };

export type { Sink };
