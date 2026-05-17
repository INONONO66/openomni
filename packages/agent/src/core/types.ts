import type { AgentProfile, Tool, Sink, Policy, Message, Token, Model } from "@openomni/protocol";
import type { Provider, RunInput } from "@openomni/llm";
import type { PolicyRegistration } from "./policy/types";
import type { AgentRuntimeContext } from "./runtime-context";
import type { Memory } from "./memory";

export interface AgentEventEmitter {
  emit(eventName: string, data: Record<string, unknown>): void;
}

export interface TokenUsage extends Token.AgentUsage {}

export interface AgentBudget extends AgentProfile.AgentBudget {}

export interface ChatAgentConfig {
  systemPrompt?: string;
  tools?: Tool.Spec[];
  model: Model.Ref;
  budget?: AgentBudget;
  onStepFinish?: (step: AgentStep) => void | Promise<void>;
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  signal?: AbortSignal;
  permissions?: Policy.Permission;
  compaction?: {
    contextWindowTokens: number;
    thresholdRatio?: number;
    reserveTokens?: number;
    reserveRatio?: number;
    protectRecentMessages?: number;
    onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  };
  memory?: Memory;
  eventEmitter?: AgentEventEmitter;
  providerOptions?: Record<string, unknown>;
  auth?: RunInput["auth"];
  allowAuthFallback?: RunInput["allowAuthFallback"];
  middleware?: PolicyRegistration[];
  context?: AgentRuntimeContext;
  llm?: {
    run?: (input: RunInput, sink: Sink) => Promise<import("@openomni/protocol").Run.Outcome>;
    resolveProviderModel?: (model: Model.Ref) => Promise<Provider.Model>;
  };
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
  | {
      type: "hook_verdict";
      timing: Policy.Timing;
      action: Policy.PolicyDecision["verdict"];
      reason?: string;
    };

export type { Sink };
