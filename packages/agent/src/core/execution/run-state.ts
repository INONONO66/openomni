import type { RunInput } from "@openomni/llm";
import type { Message, Policy, Sink, Tool, TraceContext } from "@openomni/protocol";
import {
  createBudgetState,
  recordTokenUsage,
  recordToolCall,
  recordTurn,
  type BudgetState,
} from "../budget";
import type { AgentResult, AgentStep, ChatAgentConfig, ChatAgentInput, TokenUsage } from "../types";
import type { DispatchContext } from "../policy";
import { createUserMessage, createAssistantMessage } from "../message-factory";

// merged from shared.ts (fragment sweep: single-consumer fn)
function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
  source: string,
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.at(-1)?.info.id ?? "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, source)
        : createAssistantMessage(message.content, parentID, source),
    );
  }

  return output;
}

/**
 * A run's trace context after the runner has refused an incomplete one. The
 * three ids are inherited from whatever asked for the run; every downstream
 * stage takes this type rather than the partial one, so none of them has to
 * decide what to do about a missing id.
 */
export type RunTrace = TraceContext.Type & {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
};

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
  /**
   * The turn's assistant message as projected by the llm fold (#557): the
   * latest boundary snapshot, immutable, with all parts (tool + reasoning
   * included). This is the single source of truth for what enters history
   * at turn end (#546).
   */
  readonly turnAssistant: { message?: Message.WithParts };
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
  | { type: "ready"; turn: TurnArtifacts }
  | { type: "complete"; result: AgentResult };

/**
 * What the run does after an attempt raised. `complete` carries the result a
 * guard settled on; the other two carry the error, which the caller either
 * sleeps on and retries or rethrows.
 */
export type ErrorDecision =
  | { action: "retry"; error: Error; errorMessage: string }
  | { action: "complete"; result: AgentResult; errorMessage: string }
  | { action: "throw"; error: Error; errorMessage: string };

export function createRunState(input: ChatAgentInput & { traceContext: RunTrace }): RunState {
  const sessionId = input.traceContext.sessionId;
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
    // Every builtin dispatched at a lifecycle point reads its trace from here.
    // Omitting it made a policy that reports — compaction — refuse at a
    // fail-closed point, which reads as the run aborting.
    traceContext: {
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId || state.sessionId,
      ...(agentBase.runId === undefined ? {} : { runId: agentBase.runId }),
    },
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
