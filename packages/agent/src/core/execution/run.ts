import {
  Provider,
  Retry as LlmRetry,
  Run,
  observeRetry,
  run as llmRun,
  type Sink,
} from "@openomni/llm";
import { selectModel } from "@openomni/llm";
import type { PlainValue } from "@openomni/protocol";
import { CompactionSession } from "../../compaction";
import { DEFAULT_PROTECT_RECENT } from "../../compaction/contract";
import { estimateMessagesTokens } from "../../compaction/estimate";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { evaluateBudget, publishBudgetTelemetry } from "../budget";
import { AgentStopError } from "./stop-chain";
import { assertToolExecutor, assertUnambiguousToolMetadata } from "./tools";
import {
  buildTurn,
  handleContinue,
  handleStop,
  prepareCompactionAfterContinue,
  drainStepBoundary,
  applyCompaction,
} from "./turn";
import {
  emitRunCompleted,
  emitRunFailed,
  emitRunStarted,
  emitTurnStart,
  emitErrorRetry,
} from "./run-events";
import {
  createRunState,
  recordRunAttempt,
  recordRunWindow,
  resetModelWindowGuards,
  nonEmptyString,
  requireTrace,
  type AgentRunBase,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "./state";

/** Stateless L3 orchestration; the session supplies the only execution authority. */
export async function runAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): Promise<AgentResult> {
  const trace = requireTrace("agent run", input.traceContext);
  assertToolExecutor(config);
  assertUnambiguousToolMetadata(config);
  if (config.executor === undefined || config.execution === undefined)
    throw new Error("agent run requires session execution authority");
  const state = createRunState({ ...input, traceContext: trace });
  const base = {
    traceId: trace.traceId,
    sessionId: trace.sessionId,
    runId: trace.runId,
    actorId: nonEmptyString(trace.agentName) ?? trace.runId,
  };
  const compaction = createCompactionSession(config);
  emitRunStarted(config.events, trace, config.model.id);
  try {
    for (;;) {
      await drainStepBoundary(state, config, "before_llm");
      if (
        publishBudgetTelemetry(state.budgetState, base, config.events, config.budget) === "exceeded"
      ) {
        throw new AgentStopError("budget");
      }
      const result = await runModelStep(state, config, sink, trace, base, compaction);
      if (result !== undefined) return finish(result);
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const facts = {
      reason: Retry.isAbort(cause, config.signal)
        ? ("aborted" as const)
        : LlmRetry.attemptReason(cause),
      attempt: state.attempt,
      maxAttempts: LlmRetry.MAX_ATTEMPTS,
    };
    emitRunFailed(config.events, base, cause.message, facts);
    if (Run.FailureError.isInstance(error))
      Retry.attachFailureFacts(cause, { ...facts, llm: true });
    throw error;
  } finally {
    compaction?.abort();
  }

  function finish(result: AgentResult): AgentResult {
    emitRunCompleted(config.events, state, base, result.finishReason);
    return result;
  }
}

async function runModelStep(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  base: AgentRunBase,
  compaction: CompactionSession | undefined,
): Promise<AgentResult | undefined> {
  const executor = config.executor;
  const execution = config.execution;
  if (executor === undefined || execution === undefined)
    throw new Error("missing session execution authority");
  let turn: TurnArtifacts | undefined;
  const priorFailures = [...state.modelFailureReasons];
  let provider = config.model.provider;
  const prepareAttempt = async (attempt: number, failures: readonly string[]) => {
    recordRunAttempt(state, attempt);
    const selected = selectModel(
      [config.model, ...(config.modelFallbacks ?? [])],
      [...priorFailures, ...failures],
    );
    const model = await (config.llm?.resolveModel ?? Provider.resolveModel)(selected.model);
    const modelKey = `${model.providerID}/${model.id}`;
    if (state.modelKey !== undefined && state.modelKey !== modelKey) resetModelWindowGuards(state);
    state.modelKey = modelKey;
    provider = model.providerID;
    recordRunWindow(state, model.limit?.context ?? 0);
    if (
      state.contextWindowTokens !== undefined &&
      estimateMessagesTokens(state.messages) > state.contextWindowTokens
    ) {
      await applyCompaction(state, config, base, compaction, "yield");
    }
    emitTurnStart(config.events, state, base);
    const built = await buildTurn(state, config, model, config.toolChoice, trace, sink);
    if (built.type !== "ready") throw new Error("model context admission produced no turn");
    turn = built.turn;
    const prepared = turn;
    return {
      fallbackAvailable: selected.index < (config.modelFallbacks?.length ?? 0),
      request: {
        op: "chat",
        intent: {
          attempt,
          provider: model.providerID,
          model: model.id,
          messageIds: state.messages.map((m) => m.info.id),
        },
        effect: {},
      },
      admit: async () => {
        config.signal?.throwIfAborted();
        if (
          evaluateBudget(
            { ...state.budgetState, turns: Math.max(0, state.budgetState.turns - 1) },
            config.budget,
          ).status === "exceeded"
        )
          throw new AgentStopError("budget");
        if (
          state.contextWindowTokens !== undefined &&
          estimateMessagesTokens(state.messages) > state.contextWindowTokens
        ) {
          throw new Error("model context admission exceeded");
        }
      },
      body: async () => {
        const result = await (config.llm?.run ?? llmRun)(prepared.runInput, prepared.trackingSink);
        if (result.type === "aborted") throw result.error ?? Retry.abortError();
        if (result.type === "error") throw result.error;
        return result;
      },
    };
  };
  const initial = await prepareAttempt(1, []);
  const outcome = await executor.run(
    {
      kind: "llm",
      op: "chat",
      intent: initial.request.intent,
      effect: {},
    },
    (parent) =>
      execution.runAttempts(parent, {
        prepare: async (attempt, failures) =>
          attempt === 1 ? initial : prepareAttempt(attempt, failures),
        recoverOverflow: async () => {
          if (state.overflowCompactionAttempted) return false;
          state.overflowCompactionAttempted = true;
          return (await applyCompaction(state, config, base, compaction, "yield")) === "compacted";
        },
        onRetry: (decision) => {
          state.modelFailureReasons.push(decision.reason);
          emitErrorRetry(config.events, base, {
            attempt: decision.attempt,
            maxAttempts: decision.maxAttempts,
            error: decision.error.message,
            reason: LlmRetry.attemptReason(decision.error),
            backoffMs: decision.delayMs,
          });
          if (decision.reason !== "context_overflow" && decision.decision.retry)
            observeRetry(config.events, {
              ...base,
              provider,
              attempt: decision.attempt,
              maxAttempts: decision.maxAttempts,
              decision: decision.decision,
            });
        },
      }),
  );
  if (outcome.terminal !== "executed")
    throw new Error(`llm execution ${outcome.terminal}: ${outcome.reason}`);
  if (turn === undefined) throw new Error("llm execution lost its prepared turn");
  const type = successfulOutcome(outcome.value);
  if (type === "continue") {
    handleContinue(config.events, state, base, turn.turnUsage);
    prepareCompactionAfterContinue(state, config, compaction);
    return undefined;
  }
  const result = await handleStop(state, config, base, turn, compaction);
  return result === "continue" ? undefined : result;
}

/** Only successful machine outcomes can cross the executor's encoded result boundary. */
function successfulOutcome(value: PlainValue): "stop" | "continue" {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.type === "stop" || value.type === "continue")
  )
    return value.type;
  throw new Error("invalid llm execution result");
}

function createCompactionSession(config: ChatAgentConfig): CompactionSession | undefined {
  const options = config.compaction;
  if (options?.onSummarize === undefined || options.speculate === false) return undefined;
  return new CompactionSession({
    protectRecentMessages: options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT,
    summarize: options.onSummarize,
    summarizerDeadlineMs: options.summarizerDeadlineMs,
  });
}
