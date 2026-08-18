import type { RunInput } from "@openomni/llm";
import type { Message, Policy, Sink, TraceContext } from "@openomni/protocol";
import {
  createBudgetState,
  recordTokenUsage,
  recordToolCall,
  recordTurn,
  type BudgetState,
} from "../budget";
import type { AgentResult, AgentStep, ChatAgentConfig, ChatAgentInput, TokenUsage } from "../types";
import type { DispatchContext } from "../policy";
import type { TerminalReason } from "../retry";
import { createUserMessage, createAssistantMessage } from "../message-factory";

function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
  source: string,
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.at(-1)?.info.id ?? "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, source, message.partMetadata)
        : createAssistantMessage(message.content, parentID, source, message.partMetadata),
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

/**
 * Builds a {@link RunTrace}, refusing an incomplete one.
 *
 * A run or a tool call whose traceId, sessionId, and runId were invented on
 * its behalf emits records that correlate to nothing, and the caller never
 * learns it forgot (#606). `subject` names the boundary that refused, and the
 * message lists what was missing rather than only that something was.
 *
 * What is required is inheritance, not wire format. Whether the identity is
 * expressible as a W3C `traceparent` is enforced by the emitter that puts it
 * on the wire, which is the only place the format matters.
 */
export function requireTrace(
  subject: string,
  traceContext: TraceContext.Type | undefined,
): RunTrace {
  const traceId = nonEmptyString(traceContext?.traceId);
  const sessionId = nonEmptyString(traceContext?.sessionId);
  const runId = nonEmptyString(traceContext?.runId);
  if (traceId === undefined || sessionId === undefined || runId === undefined) {
    const missing = [
      traceId === undefined ? "traceId" : undefined,
      sessionId === undefined ? "sessionId" : undefined,
      runId === undefined ? "runId" : undefined,
    ].filter((field): field is string => field !== undefined);
    throw new Error(`${subject} requires a trace context with ${missing.join(", ")}`);
  }
  return { ...traceContext, traceId, sessionId, runId };
}

/** A present, non-blank string. The one shape a trace field may take. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A run's identity, all four fields required. The runner builds exactly one of
 * these, from a trace it refused to mint (#606); nothing else may synthesize
 * one, so every consumer can read the fields rather than guess at them.
 */
export interface AgentRunBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
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
  /**
   * Provider-measured context of the most recent model call
   * (input + cache read + cache write), undefined until one completes.
   * The compaction trigger reads this — never the cumulative run spend.
   */
  lastCallContextTokens?: number;
  /**
   * L5: the one-shot overflow recovery. A provider context-overflow may
   * re-enter the compaction seam and retry exactly once per run; a second
   * overflow ends the run honestly.
   */
  overflowCompactionAttempted?: boolean;
  /**
   * The resolved model's context window — a fact of the model, recorded when
   * the loop resolves it, so strategy config never has to re-derive it.
   * Undefined when the catalog does not know (proxy models report 0).
   */
  contextWindowTokens?: number;
  /**
   * Set when a window yield fired and the seam reclaimed nothing: the run
   * proceeds with the yield disarmed — the remaining headroom is real, and
   * re-yielding every step would kill a run the window could still carry.
   */
  windowYieldDisarmed?: boolean;
  turnIndex: number;
  /** The last `turnIndex` charged to the budget; -1 before the first turn. */
  chargedTurnIndex: number;
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
  readonly toolPolicyDecisions: Array<{ readonly decision: Policy.PolicyDecision }>;
  /** The step budget this turn was given — a turn that used all of it ended on the cap, not a window yield. */
  readonly stepCap: number;
  /** Whether the window-yield knob was armed (a known window existed). */
  readonly windowYieldArmed: boolean;
}

export type BuildTurnResult =
  | { type: "ready"; turn: TurnArtifacts }
  | { type: "complete"; result: AgentResult };

/** What the terminal record needs. Emitted by the runner, which owns it. */
export interface RunFailureFacts {
  readonly reason: TerminalReason;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * What the run does after an attempt raised. `complete` carries the result a
 * guard settled on. The other two carry what the terminal record would need,
 * because the runner owns that record and the wait between attempts: a run
 * aborted mid-backoff has to report the reason and ceiling that were decided,
 * not ones re-derived from the abort.
 */
export type ErrorDecision =
  | { action: "retry"; backoffMs: number; failure: RunFailureFacts }
  | { action: "complete"; result: AgentResult }
  | { action: "throw"; error: Error; failure: RunFailureFacts };

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
    chargedTurnIndex: -1,
    startTime: Date.now(),
  };
}

export function getCompactionCount(state: RunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}

/**
 * Charges the turn budget for the turn about to run, once.
 *
 * A retried attempt is the same turn tried again: the runner re-enters
 * `buildTurn` without advancing `turnIndex`, so charging per attempt would let
 * a transient provider error eat headroom an operator sized in turns of work.
 */
export function recordRunTurn(state: RunState): void {
  if (state.chargedTurnIndex === state.turnIndex) return;
  state.chargedTurnIndex = state.turnIndex;
  state.budgetState = recordTurn(state.budgetState);
}

export function recordRunToolCall(state: RunState, durationMs: number): void {
  state.budgetState = recordToolCall(state.budgetState, durationMs);
}

export function recordCallContext(state: RunState, contextTokens: number): void {
  state.lastCallContextTokens = contextTokens;
}

export function recordRunWindow(state: RunState, contextWindowTokens: number): void {
  state.contextWindowTokens = contextWindowTokens > 0 ? contextWindowTokens : undefined;
}

export function disarmWindowYield(state: RunState): void {
  state.windowYieldDisarmed = true;
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
  // The measurement described the window this rewrite just changed. Clearing
  // it makes the next completion check skip-and-record rather than re-fire
  // compaction on a number about history that no longer exists.
  state.lastCallContextTokens = undefined;
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
  replaceRunMessages(state, messages);
  state.compactionCount += 1;
  return messagesBefore;
}

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
    contextTokens: state.lastCallContextTokens,
    contextWindowTokens: state.contextWindowTokens,
    // Every builtin dispatched at a lifecycle point reads its trace from here.
    // Omitting it made a policy that reports — compaction — refuse at a
    // fail-closed point, which reads as the run aborting.
    traceContext: {
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      runId: agentBase.runId,
    },
    ...rest,
    actorId: agentBase.actorId,
    sessionId: agentBase.sessionId,
    runId: agentBase.runId,
    // The generic is what makes each point's declared inputs type-check at the
    // eleven call sites; the cost is this one cast. TypeScript cannot prove an
    // object literal satisfies `Omit<TOverrides, K>` while `TOverrides` is
    // still a parameter, and a single assertion is rejected as
    // non-overlapping for the same reason.
  } as unknown as Omit<DispatchContext, "actorId" | "sessionId" | "runId"> &
    Omit<TOverrides, "actorId" | "sessionId" | "runId"> & {
      readonly actorId: string;
      readonly sessionId: string;
      readonly runId: string;
    };
}
