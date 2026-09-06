import { buildSystemPrompt, prepareTurnTools } from "./tools";
import { accumulateUsage, type RunInput, type Sink } from "@openomni/llm";
import { Message, type BusEvent, Operational, PlainValueSchema } from "@openomni/protocol";
import { effectiveMaxToolCalls, publishBudgetTelemetry } from "../budget";
import { Compaction, type CompactionSession } from "../../compaction";
import { executeCompaction } from "../../compaction/execute-cut";
import { resolveCompactionGeometry } from "../../compaction/geometry";
import { measuredContextTokens } from "../../compaction/measure";
import { createAssistantMessage, createUserMessage, withMessageId } from "../message-factory";
import { settleModelTools } from "./tool-wave";
import { AgentStopError } from "./stop-chain";
import * as Retry from "../retry";
import type { AgentResult, ChatAgentConfig, TokenUsage } from "../types";
import { emitTurnComplete, runResult } from "./run-events";
import {
  advanceRunTurn,
  applyCompactionMessages,
  disarmWindowYield,
  appendRunMessages,
  appendRunStep,
  recordAssistantTokenDelta,
  recordCallContext,
  recordRunTurn,
  setLastAssistantText,
  type AgentRunBase,
  type BuildTurnResult,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "./state";

export async function buildTurn(
  state: RunState,
  config: ChatAgentConfig,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: RunTrace,
  sink?: Sink,
): Promise<BuildTurnResult> {
  recordRunTurn(state);
  if (config.signal?.aborted) throw Retry.abortError();

  const tools = prepareTurnTools(state, config);
  const system = buildSystemPrompt(config.systemPrompt, tools.allTools);
  const selectedTools = tools.allTools;

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  // The session loop spends the remaining tool-call budget; provider I/O is one step.
  const toolCallPool = effectiveMaxToolCalls(config.budget);
  const stepCap =
    toolCallPool === -1
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, toolCallPool - state.budgetState.toolCalls);
  const yieldAtInputTokens =
    state.contextWindowTokens === undefined || state.windowYieldDisarmed === true
      ? undefined
      : Math.floor(
          resolveCompactionGeometry({
            contextWindowTokens: state.contextWindowTokens,
            ...(state.lastCompactionYield === undefined
              ? {}
              : { previousYield: state.lastCompactionYield }),
          }).thresholdTokens,
        );
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnAssistant);
  // Steering (#751): the host check is wrapped so the turn records WHY the
  // loop stopped — without the flag, a steering yield below the step cap is
  // indistinguishable from a cap end and would terminate as "max-steps".
  const steering: TurnArtifacts["steering"] = { requested: false };
  const steeringPending = config.steeringPending;

  return {
    type: "ready",
    turn: {
      toolExecutor: tools.executor,
      runInput: {
        events: config.events,
        // ALIASING INVARIANT: this is `state.messages` itself, not a copy.
        // Effects that append to run history between here and the llm call
        // (prompt injections, continuation messages) are visible to this
        // turn's model input by design; effects that REPLACE history
        // (`replaceRunMessages`) swap the array and are deliberately NOT
        // visible to an already-built turn. Do not "fix" either direction.
        messages: state.messages,
        tools: selectedTools,
        system,
        signal: config.signal,
        model: providerModel,
        auth: config.auth,
        authProvider: config.model.provider,
        ...(config.transport === undefined ? {} : { transport: config.transport }),
        allowAuthFallback: config.allowAuthFallback,
        toolChoice: configuredToolChoice,
        maxSteps: stepCap,
        // Yield at the same ratio the compaction trigger defaults to: the
        // loop stops at a step boundary once the window fills, the seam
        // below gets its chance on every path — Resident and tool loops
        // included, not just injected continuations (#649 reachability map).
        ...(yieldAtInputTokens === undefined ? {} : { yieldAtInputTokens }),
        ...(steeringPending === undefined
          ? {}
          : {
              shouldYield: () => {
                if (!steeringPending()) return false;
                steering.requested = true;
                return true;
              },
            }),
        providerOptions: config.providerOptions,
        trace: { traceId: trace.traceId, sessionId: trace.sessionId, runId: trace.runId },
      },
      trackingSink,
      turnAssistant,
      turnUsage,
      stepCap,
      windowYieldArmed: yieldAtInputTokens !== undefined,
      steering,
      toolPolicyDecisions: [],
    },
  };
}

function createTrackingSink(
  state: RunState,
  sink: Sink | undefined,
  turnUsage: TokenUsage,
  turnAssistant: TurnArtifacts["turnAssistant"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;
  let previousAux = { reasoning: 0, read: 0, write: 0 };

  return {
    onMessage: (message: Message.WithParts) => {
      if (message.info.role === "assistant") {
        // Boundary snapshots are immutable fold states (#557); the latest one
        // IS the turn's assistant message — full parts, tool use included.
        // Holding it (instead of re-extracting text) keeps one source of
        // truth for what enters history at turn end (#546).
        turnAssistant.message = message;
        // Tokens arrive once, stamped by message.finished; intermediate
        // boundary snapshots carry zeros, so this delta fires once per attempt.
        const tokens = message.info.tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        const delta = {
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          reasoningTokens: tokens.reasoning - previousAux.reasoning,
          cacheReadTokens: tokens.cache.read - previousAux.read,
          cacheWriteTokens: tokens.cache.write - previousAux.write,
        };
        previousAux = {
          reasoning: tokens.reasoning,
          read: tokens.cache.read,
          write: tokens.cache.write,
        };
        if (
          deltaInput > 0 ||
          deltaOutput > 0 ||
          delta.reasoningTokens > 0 ||
          delta.cacheReadTokens > 0 ||
          delta.cacheWriteTokens > 0
        ) {
          accumulateUsage(turnUsage, delta);
          recordAssistantTokenDelta(state, delta);
          const measured = measuredContextTokens(message);
          if (measured !== undefined) recordCallContext(state, measured);
        }
      }
      const text = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) setLastAssistantText(state, text);
      sink?.onMessage(message);
    },
    onToolCall: (call) => sink?.onToolCall(call),
    onToolResult: (result) => sink?.onToolResult(result),
  };
}

async function recordAssistant(
  config: ChatAgentConfig,
  message: Message.WithParts,
): Promise<Message.WithParts> {
  if (config.executor === undefined) throw new Error("missing message authority");
  const result = await config.executor.run(
    { kind: "message", op: "assistant", intent: { messageId: message.info.id }, effect: {} },
    async () => PlainValueSchema.parse(message),
  );
  if (result.terminal !== "executed")
    throw new Error(`assistant persistence refused: ${result.reason}`);
  return Message.WithParts.parse(result.value);
}

export type StopOutcome = AgentResult | "continue";

/**
 * A turn whose last step still asked for tools did not finish — the llm loop
 * stopped it: at the step cap, or at the window-yield boundary the loop arms
 * from the recorded model window. Anything else is the model's own stop.
 */
function turnYield(
  turn: TurnArtifacts,
  assistantMessage: Message.WithParts,
): "window" | "steps" | "steer" | null {
  let steps = 0;
  let lastReason: string | undefined;
  for (const part of assistantMessage.parts) {
    if (part.type === "step-finish") {
      steps += 1;
      lastReason = part.reason;
    }
  }
  if (lastReason !== "tool-calls") return null;
  if (steps >= turn.stepCap) return "steps";
  // The cap outranks steering: a turn that spent its whole step budget ended
  // on the cap even if the steering check also fired — "max-steps" stays the
  // honest terminal. Steering outranks the window: the pending message should
  // reach the model next turn; a still-full window re-arms and yields again.
  if (turn.steering.requested) return "steer";
  return turn.windowYieldArmed ? "window" : "steps";
}

export async function handleStop(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  compaction: CompactionSession | undefined,
): Promise<StopOutcome> {
  const assistantIndex = state.messages.length;
  const initialAssistant = await recordAssistant(
    config,
    resolveTurnAssistant(config.events, state, turn, agentBase),
  );
  turn.turnAssistant.message = initialAssistant;
  appendRunMessages(state, [initialAssistant]);
  const afterModelPrompts = await drainStepBoundary(state, config, "after_llm");
  const toolCalls = await settleModelTools(turn, config, state);
  const afterWavePrompts = await drainStepBoundary(state, config, "after_tools");
  if (toolCalls > 0)
    turn.turnAssistant.message = await recordAssistant(
      config,
      turn.turnAssistant.message ?? initialAssistant,
    );
  emitTurnComplete(config.events, state, agentBase, turn.turnUsage);
  const turnText = assistantTextOf(turn.turnAssistant.message);
  const step = { type: "text" as const, content: turnText };
  appendRunStep(state, step);
  if (config.onStepFinish) await config.onStepFinish(step);
  const assistantMessage = turn.turnAssistant.message ?? initialAssistant;
  state.messages[assistantIndex] = assistantMessage;
  prepareCompactionAfterContinue(state, config, compaction);

  const yielded = toolCalls > 0 ? null : turnYield(turn, assistantMessage);
  const compacted = await applyCompaction(
    state,
    config,
    agentBase,
    compaction,
    yielded === "window" ? "yield" : "threshold",
  );
  if (yielded === "window" && (compacted === "none" || state.lastCompactionIneffective))
    disarmWindowYield(state);
  const evidence = (await config.stopEvidence?.()) ?? {
    progress: false,
    blocked: false,
    openIntent: [],
    alarmIds: [],
  };
  if (config.execution === undefined) throw new Error("missing stop authority");
  const judgment = await config.execution.judgeStop(state.stop, {
    ...evidence,
    text: turnText,
    toolCalls,
    continueRequested:
      yielded === "window" || yielded === "steer" || afterModelPrompts + afterWavePrompts > 0,
    interrupted: config.signal?.aborted === true,
    exhausted:
      yielded === "steps" ||
      publishBudgetTelemetry(state.budgetState, agentBase, config.events, config.budget) ===
        "exceeded",
  });
  state.stop = judgment.state;
  if (judgment.verdict.kind === "interrupted") throw Retry.abortError();
  if (judgment.verdict.kind === "error") throw new AgentStopError(judgment.verdict.reason);
  if (judgment.verdict.kind === "continue") {
    advanceRunTurn(state);
    return "continue";
  }
  const result = runResult(state, { text: turnText });
  return judgment.verdict.kind === "waiting"
    ? { ...result, waiting: { reason: "live_wait", alarmIds: judgment.verdict.alarmIds } }
    : result;
}

/**
 * The text a turn actually produced: the text parts of its boundary snapshot,
 * empty when the turn produced none (or, on the TEST-STUB-ONLY missing-
 * snapshot path, when there is no snapshot at all — see
 * {@link resolveTurnAssistant}). Never falls back to `state.lastAssistantText`;
 * that field is the run's last produced text, kept for guard/abort results,
 * and reusing it as a turn's own output forges history (#audit M3).
 */
function assistantTextOf(message: Message.WithParts | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .filter((part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function handleContinue(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): void {
  emitTurnComplete(events, state, agentBase, turnUsage);
  advanceRunTurn(state);
}

type CompactionApplyResult = "compacted" | "deferred" | "none";

function resolvedCompaction(
  state: RunState,
  config: ChatAgentConfig,
): (NonNullable<ChatAgentConfig["compaction"]> & { contextWindowTokens: number }) | undefined {
  if (config.compaction === undefined) return undefined;
  const contextWindowTokens = config.compaction.contextWindowTokens ?? state.contextWindowTokens;
  if (contextWindowTokens === undefined) return undefined;
  return { ...config.compaction, contextWindowTokens };
}

export function prepareCompactionAfterContinue(
  state: RunState,
  config: ChatAgentConfig,
  compaction: CompactionSession | undefined,
): void {
  const options = resolvedCompaction(state, config);
  const measuredTokens = state.lastCallContextTokens;
  if (options === undefined || measuredTokens === undefined || compaction === undefined) return;
  const geometry = compactionGeometry(state, options);
  compaction.prepare(
    state.messages,
    measuredTokens,
    geometry.prepareTokens,
    options.contextWindowTokens,
  );
}

function compactionGeometry(
  state: RunState,
  options: NonNullable<ReturnType<typeof resolvedCompaction>>,
) {
  return resolveCompactionGeometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(state.lastCompactionYield === undefined
      ? {}
      : { previousYield: state.lastCompactionYield }),
  });
}

export async function applyCompaction(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  compaction: CompactionSession | undefined,
  trigger: "threshold" | "yield",
): Promise<CompactionApplyResult> {
  const options = resolvedCompaction(state, config);
  if (options === undefined) return "none";
  const measuredTokens = state.lastCallContextTokens;
  const geometry = compactionGeometry(state, options);
  if (
    trigger === "threshold" &&
    (measuredTokens === undefined ||
      !Compaction.shouldCompact(measuredTokens, options, state.lastCompactionYield))
  ) {
    return "none";
  }
  if (
    measuredTokens !== undefined &&
    compaction?.inFlight() === true &&
    measuredTokens < geometry.graceTokens
  ) {
    state.lastCompactionDeferred = true;
    return "deferred";
  }

  state.lastCompactionDeferred = undefined;
  const candidate = compaction?.candidate();
  const result = await executeCompaction({
    history: state.messages,
    options,
    identity: agentBase,
    events: config.events,
    executor: config.executor,
    signal: config.signal,
    dispatch: {
      trigger,
      ...(measuredTokens === undefined ? {} : { measuredTokens }),
      ...(candidate === undefined ? {} : { candidate }),
    },
  });
  if (candidate !== undefined) compaction?.consume();
  state.lastCompactionIneffective = result.ineffective;
  if (result.yield !== undefined) state.lastCompactionYield = result.yield;
  if (result.summarizerFailed === true) compaction?.disable();
  if (!result.compacted) return "none";
  applyCompactionMessages(state, result.messages);
  return "compacted";
}

/**
 * The turn's assistant message is the llm fold's boundary snapshot — the one
 * source of truth for what enters history (#546). The empty-text fallback is
 * a TEST-STUB-ONLY path: every production processor exit emits a finished
 * snapshot (#557), so a missing snapshot means the configured llm run never
 * drove the sink. It is loud (Operational.Events.Error) and deliberately does NOT
 * reuse lastAssistantText, which may still hold the PREVIOUS turn's text —
 * resurrecting it would forge history.
 */
function resolveTurnAssistant(
  events: BusEvent.Sink,
  state: RunState,
  turn: TurnArtifacts,
  agentBase: AgentRunBase,
): Message.WithParts {
  if (turn.turnAssistant.message !== undefined) return turn.turnAssistant.message;
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
    component: "agent.turn",
    msg: "llm sink emitted no assistant snapshot — test stub?",
  });
  const parentID = state.messages.at(-1)?.info.id ?? "";
  return createAssistantMessage("", parentID, state.sessionId);
}

export async function drainStepBoundary(
  state: RunState,
  config: ChatAgentConfig,
  boundary: "before_llm" | "after_llm" | "after_tools",
): Promise<number> {
  const drained = await config.boundary?.(boundary);
  if (drained?.interrupted || config.signal?.aborted) throw Retry.abortError();
  for (const message of drained?.messages ?? []) {
    appendRunMessages(state, [
      withMessageId(createUserMessage(message.text, state.sessionId), message.id),
    ]);
  }
  return drained?.messages.length ?? 0;
}
