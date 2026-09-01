import {
  assertToolExecutor,
  assertUnambiguousToolMetadata,
  buildTurn,
  handleContinue,
  handleError,
  handleStop,
} from "./turn";
import { ModelsDev, Provider, Retry as LlmRetry, type Run, run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/llm";
import { Placement } from "@openomni/placement";
import { DEFAULT_THRESHOLD_RATIO } from "../../compaction/compact";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { PolicyEngine, type PolicyEngineInstance } from "../policy";
import { emitRunCompleted, emitRunFailed, emitRunStarted, emitTurnStart } from "./run-events";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "./lifecycle-dispatch";
import {
  createRunState,
  recordRunAttempt,
  recordRunWindow,
  resetModelWindowGuards,
  nonEmptyString,
  requireTrace,
  type AgentRunBase,
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
type RetryPolicy = Parameters<typeof handleError>[6];

type AttemptModel = ChatAgentConfig["model"];

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
  const engine = buildPolicyEngine(config, agentBase);
  emitRunStarted(config.events, trace, config.model.id);
  const state = createRunState({ ...input, traceContext: trace });

  const finish = (result: AgentResult): AgentResult => {
    engine.endRun();
    emitRunCompleted(config.events, state, agentBase, result.finishReason);
    return result;
  };

  try {
    const preRunResult = await dispatchPreRun(state, engine, config, agentBase);
    if (preRunResult) return finish(preRunResult);
    return finish(
      await runAttempts(state, config, sink, engine, trace, agentBase, retryPolicy, progress),
    );
  } catch (error) {
    engine.endRun();
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
  }
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
  engine: RunPolicyEngine,
  trace: RunTrace,
  agentBase: AgentRunBase,
  retryPolicy: RetryPolicy,
  progress: RunProgress,
): Promise<AgentResult> {
  try {
    return await runAttempt(state, config, sink, engine, trace, agentBase, progress);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const decision = await handleError(
      state,
      engine,
      config,
      agentBase,
      error,
      progress.attempt,
      retryPolicy,
    );
    if (decision.action === "complete") return decision.result;
    if (decision.action === "throw") {
      progress.thrownFailure = decision.failure;
      throw decision.error;
    }
    // Preserve the decided failure across an abort raised by the backoff.
    progress.failureReasons.push(decision.failure.reason);
    progress.thrownFailure = decision.failure;
    await LlmRetry.sleep(decision.backoffMs, config.signal);
    progress.thrownFailure = undefined;
    progress.attempt += 1;
    return runAttempts(state, config, sink, engine, trace, agentBase, retryPolicy, progress);
  }
}

async function runAttempt(
  state: RunState,
  config: ChatAgentConfig,
  sink: Sink | undefined,
  engine: RunPolicyEngine,
  trace: RunTrace,
  agentBase: AgentRunBase,
  progress: RunProgress,
): Promise<AgentResult> {
  recordRunAttempt(state, progress.attempt);
  const attemptModel = selectAttemptModel(config, state, progress);
  const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
    attemptModel,
  );
  recordRunWindow(state, providerModel.limit?.context ?? 0);
  return runTurns(
    state,
    config,
    sink,
    engine,
    trace,
    agentBase,
    attemptModel,
    providerModel,
    progress,
  );
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
  engine: RunPolicyEngine,
  trace: RunTrace,
  agentBase: AgentRunBase,
  attemptModel: AttemptModel,
  providerModel: Provider.Model,
  progress: RunProgress,
): Promise<AgentResult> {
  const budgetResult = await dispatchBudgetCheck(state, engine, config, agentBase);
  if (budgetResult) return budgetResult;
  emitTurnStart(config.events, state, agentBase);
  const turnResult = await buildTurn(
    state,
    config,
    engine,
    providerModel,
    config.toolChoice,
    trace,
    agentBase,
    sink,
  );
  if (turnResult.type === "complete") return turnResult.result;
  const connectionResult = await runConnection(
    state,
    config,
    engine,
    agentBase,
    attemptModel,
    providerModel,
    turnResult.turn,
    progress,
  );
  if (connectionResult !== undefined) return connectionResult;
  return runTurns(
    state,
    config,
    sink,
    engine,
    trace,
    agentBase,
    attemptModel,
    providerModel,
    progress,
  );
}

async function runConnection(
  state: RunState,
  config: ChatAgentConfig,
  engine: RunPolicyEngine,
  agentBase: AgentRunBase,
  attemptModel: AttemptModel,
  providerModel: Provider.Model,
  turn: TurnArtifacts,
  progress: RunProgress,
): Promise<AgentResult | undefined> {
  const runLlm = config.llm?.run ?? llmRun;
  const gate = await dispatchModelRequest(state, engine, config, agentBase, providerModel.id);
  if (gate.blocked) return gate.blocked;
  const call = await resolveConnectionModel(
    state,
    config,
    attemptModel,
    providerModel,
    turn,
    gate.overrideModel,
  );
  const outcome = await runLlm(call.runInput, turn.trackingSink);
  const responseResult = await dispatchModelResponse(
    state,
    engine,
    config,
    { outcome, responseTokens: turn.turnUsage.outputTokens },
    agentBase,
    call.model.id,
  );
  if (responseResult) return responseResult;
  return handleModelOutcome(outcome, state, config, engine, agentBase, turn, progress);
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
      ? Math.floor(overrideWindow * DEFAULT_THRESHOLD_RATIO)
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
  engine: RunPolicyEngine,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  progress: RunProgress,
): Promise<AgentResult | undefined> {
  if (outcome.type === "stop") {
    const stopOutcome = await handleStop(state, config, engine, agentBase, turn);
    return stopOutcome === "continue" ? undefined : stopOutcome;
  }
  if (outcome.type === "continue") {
    handleContinue(config.events, state, agentBase, turn.turnUsage);
    return undefined;
  }
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

type RunPolicyEngine = PolicyEngineInstance & { readonly endRun: () => void };

export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): RunPolicyEngine {
  const engine = PolicyEngine.create({
    clock: Date.now,
    traceContext: {
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      runId: agentBase.runId,
    },
    auditEmit: (descriptor, data) => config.events.publish(descriptor, data),
  });
  const onRunEnd: Array<() => void> = [];
  for (const reg of config.middleware ?? []) {
    if (reg.kind === "factory") {
      const created = reg.create();
      // Re-wrap the already-created registration so the generic engine keeps
      // its async factory lane while this runner retains its run-end hook.
      engine.register({ kind: "factory", name: reg.name, create: () => created });
      const cleanup = (created as { readonly onRunEnd?: () => void }).onRunEnd;
      if (cleanup !== undefined) onRunEnd.push(cleanup);
    } else {
      engine.register(reg);
    }
  }
  return Object.assign(engine, {
    endRun: () => {
      for (const cleanup of onRunEnd) cleanup();
      onRunEnd.length = 0;
    },
  });
}
