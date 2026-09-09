import { buildSystemPrompt, prepareTurnTools } from "./tools";
import type { RunInput, Sink } from "@openomni/llm";
import type { Message, BusEvent } from "@openomni/protocol";
import { assistantTextOf, createTrackingSink, recordAssistant } from "./turn-assistant";
import { effectiveMaxToolCalls, publishBudgetTelemetry } from "../budget";
import type { CompactionSession } from "../../compaction";
import { applyCompaction, prepareCompactionAfterContinue } from "./turn-compaction";
import { resolveCompactionGeometry } from "../../compaction/geometry";
import { createUserMessage, withMessageId } from "../message-factory";
import { settleModelTools } from "./tool-wave";
import { AgentStopError, type StopVerdict } from "./stop-chain";
import * as Retry from "../retry";
import type { AgentResult, ChatAgentConfig, TokenUsage } from "../types";
import { emitTurnComplete, runResult } from "./run-events";
import {
  advanceRunTurn,
  disarmWindowYield,
  appendRunMessages,
  appendRunStep,
  recordRunTurn,
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

type StopOutcome = AgentResult | "continue";

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
  const snapshot = turn.turnAssistant.message;
  if (snapshot === undefined) throw new Error("llm completed without an assistant snapshot");
  const initialAssistant = await recordAssistant(config, snapshot);
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
  return stopResult(state, turnText, judgment.verdict);
}

function stopResult(state: RunState, text: string, verdict: StopVerdict): StopOutcome {
  if (verdict.kind === "interrupted") throw Retry.abortError();
  if (verdict.kind === "error") throw new AgentStopError(verdict.reason);
  if (verdict.kind === "continue") {
    advanceRunTurn(state);
    return "continue";
  }
  const result = runResult(state, { text });
  return verdict.kind === "waiting"
    ? { ...result, waiting: { reason: "live_wait", alarmIds: verdict.alarmIds } }
    : result;
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
