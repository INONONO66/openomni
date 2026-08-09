import type { RunInput } from "@openomni/llm";
import type { Message, Policy, Sink, Tool } from "@openomni/protocol";
import {
  createBudgetState,
  recordTokenUsage,
  recordToolCall,
  recordTurn,
  type BudgetState,
} from "../budget";
import type { AgentEvent, AgentStep, ChatAgentConfig, ChatAgentInput, TokenUsage } from "../types";
import type { DispatchContext } from "../policy";
import { toMessagesWithParts } from "./shared";

export interface AgentRunBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly actorId: string;
}

export interface RunState {
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

export function createRunState(input: ChatAgentInput): RunState {
  const sessionId = input.traceContext?.sessionId || "runner";
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

export function getCompactionCount(state: RunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}

export function recordRunTurn(state: RunState): void {
  state.budgetState = recordTurn(state.budgetState);
}

export function recordRunToolCall(state: RunState, durationMs: number): void {
  state.budgetState = recordToolCall(state.budgetState, durationMs);
}

export function recordAssistantTokenDelta(
  state: RunState,
  inputTokens: number,
  outputTokens: number,
): void {
  state.totalUsage.inputTokens += inputTokens;
  state.totalUsage.outputTokens += outputTokens;
  state.totalUsage.totalTokens += inputTokens + outputTokens;
  state.budgetState = recordTokenUsage(state.budgetState, inputTokens, outputTokens);
}

export function setLastAssistantText(state: RunState, text: string): void {
  state.lastAssistantText = text;
}

export function appendRunStep(state: RunState, step: AgentStep): void {
  state.steps.push(step);
}

export function appendRunMessages(state: RunState, messages: readonly Message.WithParts[]): void {
  state.messages.push(...messages);
}

export function replaceRunMessages(state: RunState, messages: Message.WithParts[]): void {
  state.messages = messages;
}

export function advanceRunTurn(state: RunState): void {
  state.turnIndex++;
}

export function advanceRunContinuation(state: RunState): void {
  state.continuationCount++;
  advanceRunTurn(state);
}

export function applyCompactionMessages(state: RunState, messages: Message.WithParts[]): number {
  const messagesBefore = state.messages.length;
  state.messages = messages;
  state.compactionCount += 1;
  return messagesBefore;
}

// merged from lifecycle-context.ts (250-LOC split refold: single-importer stage)
type LifecyclePolicyContextOverrides = Partial<
  Pick<
    DispatchContext,
    "turnCount" | "continuationCount" | "elapsedMs" | "isCompletion" | "toolInput"
  >
> &
  Record<string, unknown>;

export function buildLifecyclePolicyContext<
  const TOverrides extends LifecyclePolicyContextOverrides = Record<string, never>,
>(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  overrides: TOverrides = {} as TOverrides,
): Omit<DispatchContext, "actorId" | "sessionId" | "runId"> &
  Omit<TOverrides, "actorId" | "sessionId" | "runId"> & {
    readonly actorId: string;
    readonly sessionId: string;
    readonly runId: string;
  } {
  const { elapsedMs = Date.now() - state.startTime, ...rest } = overrides;
  return {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
    ...rest,
    actorId: agentBase.actorId,
    sessionId: agentBase.sessionId || state.sessionId,
    runId: agentBase.runId || agentBase.traceId,
  } as unknown as Omit<DispatchContext, "actorId" | "sessionId" | "runId"> &
    Omit<TOverrides, "actorId" | "sessionId" | "runId"> & {
      readonly actorId: string;
      readonly sessionId: string;
      readonly runId: string;
    };
}

export function agentBaseForState(state: RunState): AgentRunBase {
  return {
    traceId: state.sessionId,
    sessionId: state.sessionId,
    runId: state.sessionId,
    actorId: state.sessionId,
  };
}
