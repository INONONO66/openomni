import type { RunInput } from "@openomni/llm";
import type { Sink } from "@openomni/llm";
import type { Message, Policy, TraceContext } from "@openomni/protocol";
import {
  createBudgetState,
  recordTokenUsage,
  recordTurn,
  type BudgetState,
} from "../budget";
import type { AgentResult, AgentStep, ChatAgentInput, TokenUsage } from "../types";
import type { TerminalReason } from "../retry";
import { createUserMessage, createAssistantMessage } from "../message-factory";
import type { CompactionYield } from "../../compaction/geometry";

function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
  source: string,
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.at(-1)?.info.id ?? "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, source, message.partMetadata, message.time)
        : createAssistantMessage(
            message.content,
            parentID,
            source,
            message.partMetadata,
            message.time,
          ),
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
  /** Last committed structural yield; the policy and loop share its adaptive threshold. */
  lastCompactionYield?: CompactionYield;
  /** Results of the most recent apply seam, consumed by the window-yield path. */
  lastCompactionIneffective?: boolean;
  lastCompactionDeferred?: boolean;
  turnIndex: number;
  /** The last `turnIndex` charged to the budget; -1 before the first turn. */
  chargedTurnIndex: number;
  /**
   * The current retry attempt (1-based), stamped by the runner at each
   * attempt's start. Together with `turnIndex` it gives lifecycle policies an
   * attempt-scoped identity: the same turnIndex under a higher attempt is a
   * retry re-entry, never progress (#694 observation material).
   */
  attempt: number;
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
  /**
   * Whether the window-yield knob was armed for the call that actually ran.
   * Mutable on purpose: a `model.override` (#753) reroutes the connection
   * after buildTurn planned it, and turnYield must classify the stop against
   * the call's real arm state, not the plan's.
   */
  windowYieldArmed: boolean;
  /**
   * Set when the host steering check fired at a step boundary (#751) — the
   * yield disambiguator: a tool-calls stop below the step cap with this set
   * is a steering yield, not a cap end or a window yield.
   */
  readonly steering: { requested: boolean };
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
    attempt: 1,
    startTime: Date.now(),
  };
}

export function recordRunAttempt(state: RunState, attempt: number): void {
  state.attempt = attempt;
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

export function recordCallContext(state: RunState, contextTokens: number): void {
  state.lastCallContextTokens = contextTokens;
}

export function recordRunWindow(state: RunState, contextWindowTokens: number): void {
  state.contextWindowTokens = contextWindowTokens > 0 ? contextWindowTokens : undefined;
}

export function disarmWindowYield(state: RunState): void {
  state.windowYieldDisarmed = true;
}

/**
 * Clears the model-scoped window guards on a fallback model switch (#752
 * review F3). `windowYieldDisarmed` ("the remaining headroom is real") and
 * the spent L5 one-shot overflow recovery are judgments about ONE model's
 * window; carried onto a different model, a smaller fallback window would be
 * fired blind with its recovery already consumed.
 */
export function resetModelWindowGuards(state: RunState): void {
  state.windowYieldDisarmed = undefined;
  state.lastCompactionYield = undefined;
  state.lastCompactionIneffective = undefined;
  state.lastCompactionDeferred = undefined;
  state.overflowCompactionAttempted = undefined;
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

function replaceRunMessages(state: RunState, messages: Message.WithParts[]): void {
  state.messages = messages;
  // The measurement described the window this rewrite just changed. Clearing
  // it makes the next completion check skip-and-record rather than re-fire
  // compaction on a number about history that no longer exists.
  state.lastCallContextTokens = undefined;
}

export function applyCompactionMessages(
  state: RunState,
  messages: Message.WithParts[],
): number {
  const messagesBefore = state.messages.length;
  replaceRunMessages(state, messages);
  state.compactionCount += 1;
  return messagesBefore;
}

export function advanceRunTurn(state: RunState): void {
  state.turnIndex++;
}
