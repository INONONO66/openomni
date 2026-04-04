import type { Tool, Sink, Guardrail, Message, Hook } from "@openomni/protocol";
import type { Memory } from "./memory";

export type ParallelToolsMode = "off" | "safe-only" | "all";

export type StepGuardVerdict =
  | { action: "continue" }
  | { action: "inject"; message: string }
  | { action: "abort"; reason?: string };

export interface StepGuardContext {
  steps: AgentStep[];
  usage: TokenUsage;
  turnCount: number;
  isCompletion: boolean;
  continuationCount: number;
  elapsedMs: number;
}

export interface HookContext {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: string;
  steps: AgentStep[];
  turnCount: number;
  elapsedMs: number;
}

export type HookVerdict = Hook.Verdict;

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
  totalCost?: number;
}

export interface AgentBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxToolRuntimeMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCost?: number;
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
  permissions?: Guardrail.ToolPermission;
  compaction?: {
    contextWindowTokens: number;
    thresholdRatio?: number;
    protectRecentMessages?: number;
    onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  };
  parallelTools?: ParallelToolsMode;
  memory?: Memory;
  stepGuard?: (
    step: AgentStep,
    context: StepGuardContext,
  ) => Promise<StepGuardVerdict> | StepGuardVerdict;
  hooks?: ExecutionHooks;
  eventEmitter?: AgentEventEmitter;
}

export interface ChatAgentInput {
  messages: Array<{ role: "user"; content: string } | { role: "assistant"; content: string }>;
  metadata?: Record<string, unknown>;
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
  finishReason: "stop" | "tool-calls" | "max-steps" | "handoff";
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
