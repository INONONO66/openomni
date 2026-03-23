import type { Tool, Sink, Guardrail, Message } from "@openomni/protocol";
import type { ParallelToolsMode } from "./execution/parallel-tools";
import type { Memory } from "./memory";

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
}

export interface ChatAgentInput {
  messages: Array<
    { role: "user"; content: string } | { role: "assistant"; content: string }
  >;
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
  | { type: "complete"; result: AgentResult };

export type { Sink };
