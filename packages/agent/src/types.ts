import type { Tool, Sink } from "@openomni/protocol";

/**
 * Token usage statistics from LLM execution
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Budget constraints for agent execution
 */
export interface AgentBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxToolRuntimeMs?: number;
}

/**
 * Configuration for ChatAgent initialization
 */
export interface ChatAgentConfig {
  systemPrompt?: string;
  tools?: Tool.Spec[];
  model: {
    provider: string;
    id: string;
  };
  budget?: AgentBudget;
  onStepFinish?: (step: AgentStep) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Input to ChatAgent.run() or ChatAgent.stream()
 */
export interface ChatAgentInput {
  messages: Array<
    { role: "user"; content: string } | { role: "assistant"; content: string }
  >;
  metadata?: Record<string, unknown>;
}

/**
 * A single step in agent execution (tool call or text generation)
 */
export interface AgentStep {
  type: "tool-call" | "text";
  content: string;
  toolCalls?: Tool.Call[];
  toolResults?: Tool.Result[];
}

/**
 * Result of agent execution
 */
export interface AgentResult {
  text: string;
  steps: AgentStep[];
  usage: TokenUsage;
  finishReason: "stop" | "tool-calls" | "max-steps" | "handoff";
  handoffTarget?: string;
}

// Re-export Sink for convenience
export type { Sink };
