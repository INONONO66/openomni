import type { RunInput } from "@openomni/llm";
import type { Message, Policy, Sink, Tool } from "@openomni/protocol";
import {
  createBudgetState,
  recordTokenUsage,
  recordToolCall,
  recordTurn,
  type BudgetState,
} from "../budget";
import type { AgentEvent, AgentStep, ChatAgentInput, TokenUsage } from "../types";
import { toMessagesWithParts } from "./shared";

export interface StreamAgentBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId?: string;
}

export interface StreamRunState {
  readonly sessionId: string;
  budgetState: BudgetState;
  messages: Message.WithParts[];
  lastAssistantText: string;
  readonly steps: AgentStep[];
  readonly totalUsage: TokenUsage;
  continuationCount: number;
  compactionCount: number;
  turnIndex: number;
  readonly startTime: number;
}

export interface TurnArtifacts {
  readonly runInput: RunInput;
  readonly trackingSink: Sink;
  readonly turnUsage: TokenUsage;
  readonly turnToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  readonly turnToolResults: Array<{
    toolCallId: string;
    result: Tool.Result;
  }>;
  readonly toolPolicyDecisions: Array<{
    readonly timing: Policy.Timing;
    readonly decision: Policy.PolicyDecision;
  }>;
}

export type BuildTurnResult =
  | {
      type: "ready";
      budgetReassuranceEvent?: Extract<AgentEvent, { type: "budget_reassurance" }>;
      budgetWarningEvent?: Extract<AgentEvent, { type: "budget_warning" }>;
      turn: TurnArtifacts;
    }
  | { type: "complete"; event: AgentEvent };

export type TurnDecision =
  | {
      kind: "continue";
      messages: Message.WithParts[];
      continuationCount: number;
      compactionCount: number;
      turnIndex: number;
    }
  | { kind: "complete"; event: AgentEvent }
  | { kind: "error"; error: unknown }
  | { kind: "abort"; event: AgentEvent };

export type ErrorDecision =
  | ({ action: "retry"; errorMessage: string } & Extract<TurnDecision, { kind: "error" }>)
  | ({ action: "complete"; errorMessage: string } & Extract<TurnDecision, { kind: "abort" }>)
  | ({ action: "throw"; errorMessage: string } & Extract<TurnDecision, { kind: "error" }>);

export function createStreamRunState(input: ChatAgentInput): StreamRunState {
  const sessionId = input.traceContext?.sessionId ?? "runner";
  return {
    sessionId,
    budgetState: createBudgetState(),
    messages: toMessagesWithParts(input.messages, sessionId),
    lastAssistantText: "",
    steps: [],
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    continuationCount: 0,
    compactionCount: 0,
    turnIndex: 0,
    startTime: Date.now(),
  };
}

export function getCompactionCount(state: StreamRunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}

export function recordStreamTurn(state: StreamRunState): void {
  state.budgetState = recordTurn(state.budgetState);
}

export function recordStreamToolCall(state: StreamRunState, durationMs: number): void {
  state.budgetState = recordToolCall(state.budgetState, durationMs);
}

export function recordAssistantTokenDelta(
  state: StreamRunState,
  inputTokens: number,
  outputTokens: number,
): void {
  state.totalUsage.inputTokens += inputTokens;
  state.totalUsage.outputTokens += outputTokens;
  state.totalUsage.totalTokens += inputTokens + outputTokens;
  state.budgetState = recordTokenUsage(state.budgetState, inputTokens, outputTokens);
}

export function setLastAssistantText(state: StreamRunState, text: string): void {
  state.lastAssistantText = text;
}

export function appendStreamStep(state: StreamRunState, step: AgentStep): void {
  state.steps.push(step);
}

export function appendStreamMessages(
  state: StreamRunState,
  messages: readonly Message.WithParts[],
): void {
  state.messages.push(...messages);
}

export function replaceStreamMessages(state: StreamRunState, messages: Message.WithParts[]): void {
  state.messages = messages;
}

export function advanceStreamTurn(state: StreamRunState): void {
  state.turnIndex++;
}

export function advanceStreamContinuation(state: StreamRunState): void {
  state.continuationCount++;
  advanceStreamTurn(state);
}

export function applyCompactionMessages(
  state: StreamRunState,
  messages: Message.WithParts[],
): number {
  const messagesBefore = state.messages.length;
  state.messages = messages;
  state.compactionCount += 1;
  return messagesBefore;
}
