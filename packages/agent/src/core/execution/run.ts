import {
  assertToolExecutor,
  assertUnambiguousToolMetadata,
  buildTurn,
  handleCompact,
  handleContinue,
  handleError,
  handleStop,
} from "./turn";
import { ModelsDev, Provider, run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
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
  recordRunWindow,
  nonEmptyString,
  requireTrace,
  type AgentRunBase,
  type RunFailureFacts,
} from "./state";

/**
 * Runs an agent to a result.
 *
 * One output channel. Streaming goes to `sink` as it happens; the record of
 * what happened goes to `config.events`; this returns what the run decided.
 * The `AgentEvent` generator that used to carry all three had no consumer
 * outside this package's own tests.
 */
export async function runAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): Promise<AgentResult> {
  const retryPolicy = Retry.DEFAULT_RETRY_POLICY;
  let attempt = 1;
  let thrownFailure: RunFailureFacts | undefined;

  const trace = requireTrace("agent run", input.traceContext);
  const { traceId, sessionId, runId } = trace;
  // The actor defaults to the run identity: no production caller threads a
  // real actor principal yet (none supplies `agentName` either), so today
  // actor ≡ runId. A validated principal lane replaces this when one exists
  // (#606). The former `input.metadata?.actorId` leg was an unvalidated
  // side-channel with zero producers and is gone.
  const actorId = nonEmptyString(trace.agentName) ?? runId;
  const agentBase = { traceId, sessionId, runId, actorId };
  // All validators run before the run is opened: `buildPolicyEngine`
  // rejects a malformed middleware registration, and a configuration error
  // must not open a run it cannot close.
  assertToolExecutor(config);
  assertUnambiguousToolMetadata(config);
  const engine = buildPolicyEngine(config, agentBase);
  emitRunStarted(config.events, trace, config.model.id);

  // #546: run state and pre-run dispatch are run-scoped, living across
  // attempts — an agent-level retry regenerates only the attempt (turn
  // artifacts), never the history, budget/usage (no double-billing reset),
  // or run.lifecycle.pre effects (prompt injections apply exactly once).
  const state = createRunState({ ...input, traceContext: trace });

  /**
   * The run's two terminals. Both live here because the run is opened here:
   * a branch that records its own end can only be relied on for the ends it
   * knows about, and the ends it does not know about are exactly the ones
   * that go unrecorded. `handleError` used to emit the failure, so anything
   * raised from inside it — an abort from `Retry.sleep`, a non-`Error` throw
   * — escaped past its own record.
   */
  const finish = (result: AgentResult): AgentResult => {
    emitRunCompleted(config.events, state, agentBase, result.finishReason);
    return result;
  };

  /**
   * A throw that never reached a retry decision — nothing decided a reason or
   * a ceiling for it, so the record says what the throw itself can support.
   * Every path that *did* reach one carries the decided facts instead.
   * Aborts are recognized by identity, never by message substrings (M4).
   */
  const undecidedFacts = (error: unknown): RunFailureFacts => ({
    reason:
      error instanceof Error && Retry.isAbort(error, config.signal)
        ? "aborted"
        : Retry.classifyRetryReason(error instanceof Error ? error.message : String(error)),
    attempt,
    maxAttempts: retryPolicy.maxAttempts,
  });

  const preRunResult = await dispatchPreRun(state, engine, config, agentBase);
  if (preRunResult) return finish(preRunResult);

  try {
    for (;;) {
      try {
        const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
          config.model,
        );
        recordRunWindow(state, providerModel.limit?.context ?? 0);
        const configuredToolChoice = config.toolChoice;

        for (;;) {
          const budgetResult = await dispatchBudgetCheck(state, engine, config, agentBase);
          if (budgetResult) return finish(budgetResult);

          emitTurnStart(config.events, state, agentBase);
          const turnResult = await buildTurn(
            state,
            config,
            engine,
            providerModel,
            configuredToolChoice,
            trace,
            agentBase,
            sink,
          );
          if (turnResult.type === "complete") return finish(turnResult.result);

          const runLlm = config.llm?.run ?? llmRun;
          const modelRequestResult = await dispatchModelRequest(state, engine, config, agentBase);
          if (modelRequestResult) return finish(modelRequestResult);
          const outcome = await runLlm(turnResult.turn.runInput, turnResult.turn.trackingSink);
          const modelResponseResult = await dispatchModelResponse(
            state,
            engine,
            config,
            {
              outcome,
              responseTokens: turnResult.turn.turnUsage.outputTokens,
            },
            agentBase,
          );
          if (modelResponseResult) return finish(modelResponseResult);

          if (outcome.type === "stop") {
            const stopOutcome = await handleStop(state, config, engine, agentBase, turnResult.turn);
            if (stopOutcome !== "continue") return finish(stopOutcome);
            continue;
          }

          if (outcome.type === "continue") {
            handleContinue(config.events, state, agentBase, turnResult.turn.turnUsage);
            continue;
          }

          if (outcome.type === "compact") {
            const compactOutcome = await handleCompact(state, engine, config, agentBase);
            if (compactOutcome !== "continue") return finish(compactOutcome);
            continue;
          }

          if (outcome.type === "aborted") throw Retry.abortError();
          if (outcome.type === "error") throw new Error(outcome.error.message);
          const _exhaustive: never = outcome;
          throw new Error(`Unknown outcome type: ${unknownOutcomeType(_exhaustive)}`);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const decision = await handleError(
          state,
          engine,
          config,
          agentBase,
          error,
          attempt,
          retryPolicy,
        );
        if (decision.action === "retry") {
          // Carried across the wait, not after it: an abort raises from inside
          // `Retry.sleep`, and the reason and ceiling it has to report are the
          // ones decided here — re-deriving them from the abort would make the
          // terminal record contradict this run's own retry record.
          thrownFailure = decision.failure;
          await Retry.sleep(decision.backoffMs, config.signal);
          thrownFailure = undefined;
          attempt += 1;
          continue;
        }
        if (decision.action === "complete") return finish(decision.result);
        thrownFailure = decision.failure;
        throw decision.error;
      }
    }
  } catch (error) {
    emitRunFailed(
      config.events,
      agentBase,
      error instanceof Error ? error.message : String(error),
      thrownFailure ?? undecidedFacts(error),
    );
    throw error;
  }
}

function unknownOutcomeType(value: unknown): string {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return "unknown";
  }

  const type = value.type;
  return typeof type === "string" ? type : "unknown";
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

export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): PolicyEngineInstance {
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      runId: agentBase.runId,
    },
    auditEmit: (descriptor, data) => config.events.publish(descriptor, data),
  });
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}
