import { assertToolExecutor, assertUnambiguousToolMetadata } from "./tool-placement";
import type { PlainValue } from "@openomni/protocol";
import {
  buildTurn,
  handleContinue,
  handleError,
  handleStop,
  prepareCompactionAfterContinue,
  drainStepBoundary,
} from "./turn";
import { ModelsDev, Provider, Retry as LlmRetry, Run, run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/llm";
import { Placement } from "@openomni/placement";
import { CompactionSession } from "../../compaction";
import { DEFAULT_PROTECT_RECENT } from "../../compaction/compact";
import { resolveCompactionGeometry } from "../../compaction/geometry";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { emitRunCompleted, emitRunFailed, emitRunStarted, emitTurnStart } from "./run-events";
import { publishBudgetTelemetry } from "../budget";
import { runResult } from "./run-events";
import {
  createRunState,
  recordRunAttempt,
  recordRunWindow,
  resetModelWindowGuards,
  nonEmptyString,
  requireTrace,
  type AgentRunBase,
  type BuildTurnResult,
  type ErrorDecision,
  type RunFailureFacts,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "./state";

/**
 * Runs an agent to a result.
 *
 * One output channel. Streaming goes to `sink` as it happens; the record of
 * what happened goes to `config.events`; this returns what the run decided.
 * The `AgentEvent` generator that used to carry all three had no consumer
 * outside this package's own tests.
 */
type RetryPolicy = Parameters<typeof Retry.shouldRetry>[0];

type AttemptModel = ChatAgentConfig["model"];

interface AttemptContext {
  attemptModel: AttemptModel;
  providerModel: Provider.Model;
}

type SuccessfulModelOutcome = Extract<Run.Outcome, { type: "stop" | "continue" }>;

const AGENT_COMPLETE = { type: "agent_complete" } as const;

class LlmExecutionRefused extends Error {
  constructor(
    readonly terminal: "blocked_pre" | "blocked_post",
    readonly reason: string,
  ) {
    super(`llm execution ${terminal}: ${reason}`);
    this.name = "LlmExecutionRefused";
  }
}

interface RunProgress {
  attempt: number;
  thrownFailure?: RunFailureFacts;
  terminalLlmError?: Error;
  readonly failureReasons: string[];
  lastModelKey?: string;
}

/** Runs an agent to a result. */
export async function runAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): Promise<AgentResult> {
  const retryPolicy = retryPolicyFor(config);
  const progress: RunProgress = { attempt: 1, failureReasons: [] };
  const trace = requireTrace("agent run", input.traceContext);
  const { traceId, sessionId, runId } = trace;
  const actorId = nonEmptyString(trace.agentName) ?? runId;
  const agentBase = { traceId, sessionId, runId, actorId };

  // Configuration is validated before opening the run.
  assertToolExecutor(config);
  assertUnambiguousToolMetadata(config);
  const state = createRunState({ ...input, traceContext: trace });
  const compaction = createCompactionSession(config);
  emitRunStarted(config.events, trace, config.model.id);

  const finish = (result: AgentResult): AgentResult => {
    emitRunCompleted(config.events, state, agentBase, result.finishReason);
    return result;
  };

  try {
    return finish(
      await runAttempts(state, config, sink, trace, agentBase, retryPolicy, progress, compaction),
    );
  } catch (error) {
    const facts =
      progress.thrownFailure ?? undecidedFailureFacts(error, config, retryPolicy, progress);
    emitRunFailed(
      config.events,
      agentBase,
      error instanceof Error ? error.message : String(error),
      facts,
    );
    if (error instanceof Error && error === progress.terminalLlmError) {
      Retry.attachFailureFacts(error, { ...facts, llm: true });
    }
    throw error;
  } finally {
    compaction?.abort();
  }
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

/** Fallbacks make validation failures retryable on a different candidate. */
function retryPolicyFor(config: ChatAgentConfig): RetryPolicy {
  if ((config.modelFallbacks?.length ?? 0) === 0) return Retry.DEFAULT_RETRY_POLICY;
  return {
    ...Retry.DEFAULT_RETRY_POLICY,
    retryOn: [...(Retry.DEFAULT_RETRY_POLICY.retryOn ?? []), "validation_error"],
  };
}

function undecidedFailureFacts(
  error: unknown,
  config: ChatAgentConfig,
  retryPolicy: RetryPolicy,
  progress: RunProgress,
): RunFailureFacts {
  return {
    reason:
      error instanceof Error && Retry.isAbort(error, config.signal)
        ? "aborted"
        : Retry.classifyRetryReason(error instanceof Error ? error.message : String(error)),
    attempt: progress.attempt,
    maxAttempts: retryPolicy.maxAttempts,
  };
}

async function runAttempts(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  agentBase: AgentRunBase,
  retryPolicy: RetryPolicy,
  progress: RunProgress,
  compaction: CompactionSession | undefined,
): Promise<AgentResult> {
  for (;;) {
    try {
      return await runAttempt(
        state,
        config,
        sink,
        trace,
        agentBase,
        progress,
        retryPolicy,
        compaction,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error instanceof LlmExecutionRefused || progress.thrownFailure !== undefined) throw error;
      const decision = await handleAttemptFailure(
        state,
        config,
        agentBase,
        error,
        progress,
        retryPolicy,
        compaction,
      );
      if (decision.action === "complete") return decision.result;
    }
  }
}

async function advanceRetry(
  config: ChatAgentConfig,
  progress: RunProgress,
  decision: Extract<ErrorDecision, { action: "retry" }>,
): Promise<void> {
  // Preserve the decided failure across an abort raised by the backoff.
  progress.failureReasons.push(decision.failure.reason);
  progress.thrownFailure = decision.failure;
  await LlmRetry.sleep(decision.backoffMs, config.signal);
  progress.thrownFailure = undefined;
  progress.attempt += 1;
}

async function handleAttemptFailure(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  error: Error,
  progress: RunProgress,
  retryPolicy: RetryPolicy,
  compaction: CompactionSession | undefined,
): Promise<Exclude<ErrorDecision, { action: "throw" }>> {
  const decision = await handleError(
    state,
    config,
    agentBase,
    error,
    progress.attempt,
    retryPolicy,
    compaction,
  );
  if (decision.action === "throw") {
    progress.thrownFailure = decision.failure;
    throw decision.error;
  }
  if (decision.action === "retry") await advanceRetry(config, progress, decision);
  return decision;
}

async function runAttempt(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  agentBase: AgentRunBase,
  progress: RunProgress,
  retryPolicy: RetryPolicy,
  compaction: CompactionSession | undefined,
): Promise<AgentResult> {
  const context = await prepareAttempt(state, config, progress);
  return runTurns(
    state,
    config,
    sink,
    trace,
    agentBase,
    context,
    progress,
    retryPolicy,
    compaction,
  );
}

async function prepareAttempt(
  state: RunState,
  config: ChatAgentConfig,
  progress: RunProgress,
): Promise<AttemptContext> {
  recordRunAttempt(state, progress.attempt);
  const attemptModel = selectAttemptModel(config, state, progress);
  const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
    attemptModel,
  );
  recordRunWindow(state, providerModel.limit?.context ?? 0);
  return { attemptModel, providerModel };
}

function selectAttemptModel(
  config: ChatAgentConfig,
  state: RunState,
  progress: RunProgress,
): AttemptModel {
  const attemptModel = Placement.selectModel(
    [config.model, ...(config.modelFallbacks ?? [])],
    progress.failureReasons,
  ).model;
  const modelKey = `${attemptModel.provider}/${attemptModel.id}`;
  if (progress.lastModelKey !== undefined && modelKey !== progress.lastModelKey) {
    resetModelWindowGuards(state);
  }
  progress.lastModelKey = modelKey;
  return attemptModel;
}

async function runTurns(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  agentBase: AgentRunBase,
  context: AttemptContext,
  progress: RunProgress,
  retryPolicy: RetryPolicy,
  compaction: CompactionSession | undefined,
): Promise<AgentResult> {
  for (;;) {
    const turnResult = await prepareTurn(state, config, sink, trace, agentBase, context);
    if (turnResult.type === "complete") return turnResult.result;
    const connectionResult = await runConnection(
      state,
      config,
      sink,
      trace,
      agentBase,
      context,
      turnResult.turn,
      progress,
      retryPolicy,
      compaction,
    );
    if (connectionResult !== undefined) return connectionResult;
  }
}

async function prepareTurn(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  agentBase: AgentRunBase,
  context: AttemptContext,
): Promise<BuildTurnResult> {
  await drainStepBoundary(state, config, "before_llm");
  const budgetStatus = publishBudgetTelemetry(
    state.budgetState,
    agentBase,
    config.events,
    config.budget,
  );
  if (budgetStatus === "exceeded") {
    return { type: "complete", result: runResult(state, { finishReason: "max-steps" }) };
  }
  emitTurnStart(config.events, state, agentBase);
  return buildTurn(state, config, context.providerModel, config.toolChoice, trace, sink);
}

async function runConnection(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  trace: RunTrace,
  agentBase: AgentRunBase,
  context: AttemptContext,
  initialTurn: TurnArtifacts,
  progress: RunProgress,
  retryPolicy: RetryPolicy,
  compaction: CompactionSession | undefined,
): Promise<AgentResult | undefined> {
  const runLlm = config.llm?.run ?? llmRun;
  let turn = initialTurn;
  const invokeModel = async (): Promise<SuccessfulModelOutcome> => {
    const call = await resolveConnectionModel(
      state,
      config,
      context.attemptModel,
      context.providerModel,
      turn,
      undefined,
    );
    const outcome = await runLlm(call.runInput, turn.trackingSink);
    return requireSuccessfulModelOutcome(outcome, progress);
  };
  const executor = config.executor;
  const lifecycle = config.execution;
  if (executor === undefined || lifecycle === undefined) {
    const outcome = await invokeModel();
    return handleModelOutcome(outcome, state, config, agentBase, turn, progress, compaction);
  }

  let completedResult: AgentResult | undefined;
  const execution = await executor.run(
    {
      kind: "llm",
      op: "chat",
      intent: {
        provider: context.providerModel.providerID,
        model: context.providerModel.id,
        messageIds: state.messages.map((message) => message.info.id),
      },
      effect: {},
    },
    async (llmIntent) => {
      for (;;) {
        try {
          return await lifecycle.runAttempt(
            llmIntent,
            {
              op: "chat",
              intent: {
                attempt: progress.attempt,
                provider: context.providerModel.providerID,
                model: context.providerModel.id,
              },
              effect: {},
            },
            invokeModel,
          );
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const decision = await handleAttemptFailure(
            state,
            config,
            agentBase,
            error,
            progress,
            retryPolicy,
            compaction,
          );
          if (decision.action === "complete") {
            completedResult = decision.result;
            return AGENT_COMPLETE;
          }
          const nextContext = await prepareAttempt(state, config, progress);
          context.attemptModel = nextContext.attemptModel;
          context.providerModel = nextContext.providerModel;
          const nextTurn = await prepareTurn(state, config, sink, trace, agentBase, context);
          if (nextTurn.type === "complete") {
            completedResult = nextTurn.result;
            return AGENT_COMPLETE;
          }
          turn = nextTurn.turn;
        }
      }
    },
  );

  if (execution.terminal !== "executed") {
    throw new LlmExecutionRefused(execution.terminal, execution.reason);
  }
  const outcome = parseLogicalLlmOutput(execution.value);
  if (outcome.type === "agent_complete") {
    if (completedResult === undefined) throw new Error("llm execution lost its completion result");
    return completedResult;
  }
  return handleModelOutcome(outcome, state, config, agentBase, turn, progress, compaction);
}

async function resolveConnectionModel(
  state: RunState,
  config: ChatAgentConfig,
  attemptModel: AttemptModel,
  providerModel: Provider.Model,
  turn: TurnArtifacts,
  overrideModel: AttemptModel | undefined,
): Promise<{ model: Provider.Model; runInput: TurnArtifacts["runInput"] }> {
  if (
    overrideModel === undefined ||
    (overrideModel.provider === attemptModel.provider && overrideModel.id === attemptModel.id)
  ) {
    return { model: providerModel, runInput: turn.runInput };
  }
  const model = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(overrideModel);
  const overrideWindow = model.limit?.context ?? 0;
  const yieldAt =
    overrideWindow > 0 && state.windowYieldDisarmed !== true
      ? Math.floor(
          resolveCompactionGeometry({
            contextWindowTokens: overrideWindow,
            ...(state.lastCompactionYield === undefined
              ? {}
              : { previousYield: state.lastCompactionYield }),
          }).thresholdTokens,
        )
      : undefined;
  const { yieldAtInputTokens: _priorYield, ...restInput } = turn.runInput;
  turn.windowYieldArmed = yieldAt !== undefined;
  return {
    model,
    runInput: {
      ...restInput,
      model,
      auth: model.providerID === config.model.provider ? config.auth : undefined,
      ...(yieldAt === undefined ? {} : { yieldAtInputTokens: yieldAt }),
    },
  };
}

async function handleModelOutcome(
  outcome: Run.Outcome,
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  progress: RunProgress,
  compaction: CompactionSession | undefined,
): Promise<AgentResult | undefined> {
  const successful = requireSuccessfulModelOutcome(outcome, progress);
  if (successful.type === "stop") {
    const stopOutcome = await handleStop(state, config, agentBase, turn, compaction);
    return stopOutcome === "continue" ? undefined : stopOutcome;
  }
  handleContinue(config.events, state, agentBase, turn.turnUsage);
  prepareCompactionAfterContinue(state, config, compaction);
  return undefined;
}

function parseLogicalLlmOutput(value: PlainValue): Run.Outcome | typeof AGENT_COMPLETE {
  if (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    value.type === AGENT_COMPLETE.type
  ) {
    return AGENT_COMPLETE;
  }
  return Run.Outcome.parse(value);
}

function requireSuccessfulModelOutcome(
  outcome: Run.Outcome,
  progress: RunProgress,
): SuccessfulModelOutcome {
  if (outcome.type === "stop" || outcome.type === "continue") return outcome;
  if (outcome.type === "aborted") throw outcome.error ?? Retry.abortError();
  if (outcome.type === "error") {
    const source = outcome.error;
    const error =
      source instanceof Error
        ? source
        : new Error(
            typeof source === "object" &&
              source !== null &&
              "message" in source &&
              typeof source.message === "string"
              ? source.message
              : String(source),
          );
    progress.terminalLlmError = error;
    throw error;
  }
  return assertKnownOutcome(outcome);
}

function assertKnownOutcome(value: never): never {
  // Handle primitives (like injected llm.run returning 0) by inspecting as unknown
  if (typeof value !== "object" || value === null) {
    throw new Error(`Unknown outcome type: unknown`);
  }
  const type = Reflect.get(value as object, "type");
  throw new Error(`Unknown outcome type: ${typeof type === "string" ? type : "unknown"}`);
}

async function resolveProviderModel(model: {
  provider: string;
  id: string;
}): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[model.provider];

  if (!providerData) {
    throw new Error(`Provider not found: ${model.provider}`);
  }

  const rawModel = providerData.models?.[model.id];
  if (rawModel) {
    return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
  }

  // A failed proxy listing is NOT "model not found": swallowing it here
  // reported an auth/network failure as a missing model (#audit L2). The
  // listing failure is surfaced in the thrown message so the operator sees
  // the real fault.
  let proxyModels: Awaited<ReturnType<typeof Provider.listModels>>;
  try {
    proxyModels = await Provider.listModels(model.provider, "proxy");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Model lookup failed for ${model.id} (provider ${model.provider}): proxy model listing failed: ${cause}`,
    );
  }
  const match = proxyModels.find((m) => m.id === model.id);
  if (match) return match;

  throw new Error(`Model not found: ${model.id} for provider ${model.provider}`);
}
