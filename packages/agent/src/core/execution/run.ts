import { Cause, Context, Effect, Scope } from "effect";
import { ForeignFailure, Interrupted, type ExecutionError } from "../../errors";
import type { LlmError } from "@openomni/llm";
import {
  Provider,
  Retry as LlmRetry,
  LlmRunFailure,
  observeRetry,
  run as llmRun,
  type Sink,
} from "@openomni/llm";
import { selectModel } from "@openomni/llm";
import { PlainValueSchema, type PlainValue } from "@openomni/protocol";
import { CompactionSession } from "../../compaction";
import { DEFAULT_PROTECT_RECENT } from "../../compaction/contract";
import { estimateMessagesTokens } from "../../compaction/estimate";
import { ExecutorContext } from "../../executor-context";
import type { Executor } from "../../executor";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../types";
import { evaluateBudget, publishBudgetTelemetry } from "../budget";
import { restoreModelSelection } from "../../model-selection";
import { failureFacts } from "../retry";
import { AgentStopError } from "./stop-chain";
import { assertToolExecutor, assertUnambiguousToolMetadata } from "./tools";
import { buildTurn, handleContinue, handleStop, drainStepBoundary } from "./turn";
import { applyCompaction, prepareCompactionAfterContinue } from "./turn-compaction";
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
export function runAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): Effect.Effect<AgentResult, ExecutionError> {
  return Effect.scopedWith((scope) => Effect.suspend(() => {
  const trace = requireTrace("agent run", input.traceContext);
  assertToolExecutor(config);
  assertUnambiguousToolMetadata(config);
  const durableExecutor = config.executor;
  if (durableExecutor === undefined || config.execution === undefined)
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
  return Effect.gen(function* () {
    state.modelChainStart = yield* restoreModelSelection(durableExecutor, config.pinnedModel, [
      config.model,
      ...(config.modelFallbacks ?? []),
    ]);
    for (;;) {
      yield* drainStepBoundary(state, config, "before_llm");
      if (
        publishBudgetTelemetry(state.budgetState, base, config.events, config.budget) === "exceeded"
      ) {
        return yield* new AgentStopError({ reason: "budget" });
      }
      const result = yield* runModelStep(state, config, sink, trace, base, compaction, durableExecutor);
      if (result !== undefined) return finish(result);
    }
  }).pipe(Effect.provide(Context.make(ExecutorContext, durableExecutor).pipe(Context.add(Scope.Scope, scope))), Effect.onError((cause) => Effect.sync(() => {
    const error = Cause.squash(cause);
    const facts = failureFacts(error);
    const interrupted = Cause.isInterrupted(cause) || error instanceof Interrupted ||
      (error instanceof LlmRunFailure && error.aborted);
    emitRunFailed(config.events, base, String(error), {
      reason: interrupted ? "aborted" : facts?.reason ?? "transient_error",
      attempt: facts?.attempt ?? state.attempt,
      maxAttempts: facts?.maxAttempts ?? LlmRetry.MAX_ATTEMPTS,
    });
  })), Effect.ensuring(compaction?.abort() ?? Effect.void));

  function finish(result: AgentResult): AgentResult {
    emitRunCompleted(config.events, state, base, result.finishReason);
    return result;
  }
  }));
}

function runModelStep(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  base: AgentRunBase,
  compaction: CompactionSession | undefined,
  durableExecutor: Executor,
): Effect.Effect<AgentResult | undefined, ExecutionError, Scope.Scope> {
  return Effect.gen(function* () {
  const executor = durableExecutor;
  const execution = config.execution;
  if (execution === undefined) return yield* new ForeignFailure({ operation: "agent.execution", cause: "missing" });
  let turn: TurnArtifacts | undefined;
  const priorFailures = [...state.modelFailureReasons];
  let provider = config.model.provider;
  const prepareAttempt = (attempt: number, failures: readonly string[]) => Effect.gen(function* () {
    recordRunAttempt(state, attempt);
    const chain = [config.model, ...(config.modelFallbacks ?? [])].slice(state.modelChainStart);
    const selected = selectModel(chain, [...priorFailures, ...failures]);
    const model = yield* (config.llm?.resolveModel ?? Provider.resolveModel)(selected.model).pipe(Effect.mapError(modelFailure));
    const modelKey = `${model.providerID}/${model.id}`;
    if (state.modelKey !== undefined && state.modelKey !== modelKey) resetModelWindowGuards(state);
    state.modelKey = modelKey;
    provider = model.providerID;
    recordRunWindow(state, model.limit?.context ?? 0);
    if (
      state.contextWindowTokens !== undefined &&
      estimateMessagesTokens(state.messages) > state.contextWindowTokens
    ) {
      yield* applyCompaction(state, config, base, compaction, "yield");
    }
    emitTurnStart(config.events, state, base);
    const built = buildTurn(state, config, model, config.toolChoice, trace, sink);
    if (built.type !== "ready") return yield* new ForeignFailure({ operation: "agent.turn", cause: "not_ready" });
    turn = built.turn;
    const prepared = turn;
    return {
      fallbackAvailable: selected.index < chain.length - 1,
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
      admit: () => Effect.suspend<void, ExecutionError, never>(() => {
        if (config.signal?.aborted) return Effect.fail(new Interrupted());
        if (
          evaluateBudget(
            { ...state.budgetState, turns: Math.max(0, state.budgetState.turns - 1) },
            config.budget,
          ).status === "exceeded"
        )
          return Effect.fail(new AgentStopError({ reason: "budget" }));
        if (
          state.contextWindowTokens !== undefined &&
          estimateMessagesTokens(state.messages) > state.contextWindowTokens
        ) {
          return Effect.die(new Error("model context admission exceeded"));
        }
        return Effect.void;
      }),
      body: () => Effect.suspend(() => (config.llm?.run ?? llmRun)(prepared.runInput, prepared.trackingSink)).pipe(
        Effect.mapError(modelFailure),
        Effect.flatMap((result) => {
          if (result.type === "aborted") return Effect.fail(result.error ?? new Interrupted());
          if (result.type === "error") return Effect.fail(result.error);
          return Effect.succeed({
            type: successfulOutcome({ type: result.type }),
            evidence: PlainValueSchema.parse(
              result.type === "stop" ? (result.evidence ?? null) : null,
            ),
          });
        }),
      ),
    };
  });
  const initial = yield* prepareAttempt(1, []);
  const outcome = yield* executor.run(
    {
      kind: "llm",
      op: "chat",
      intent: initial.request.intent,
      effect: {},
    },
    (parent: import("@openomni/protocol").LedgerAction.Receipt) =>
      execution.runAttempts(parent, {
        prepare: (attempt, failures) =>
          attempt === 1 ? Effect.succeed(initial) : prepareAttempt(attempt, failures),
        evidence: (result) => result.evidence,
        recoverOverflow: () => Effect.gen(function* () {
          if (state.overflowCompactionAttempted) return false;
          state.overflowCompactionAttempted = true;
          return (yield* applyCompaction(state, config, base, compaction, "yield")) === "compacted";
        }),
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
  if (outcome.terminal === "interrupted") return yield* new Interrupted();
  if (outcome.terminal !== "executed")
    return yield* new ForeignFailure({ operation: "agent.llm", cause: `execution_${outcome.terminal}` });
  if (turn === undefined) return yield* new ForeignFailure({ operation: "agent.llm", cause: "missing_turn" });
  const type = successfulOutcome(outcome.value);
  if (type === "continue") {
    handleContinue(config.events, state, base, turn.turnUsage);
    yield* prepareCompactionAfterContinue(state, config, compaction);
    return undefined;
  }
  const result = yield* handleStop(state, config, base, turn, compaction);
  return result === "continue" ? undefined : result;
  });
}

function modelFailure(error: LlmError): ExecutionError {
  return error instanceof LlmRunFailure ? error : new ForeignFailure({
    operation: "llm", cause: error.message,
  });
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
