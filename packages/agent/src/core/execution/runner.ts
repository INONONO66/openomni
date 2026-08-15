import { ModelsDev, Provider, run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { PolicyEngine, type PolicyEngineInstance } from "../policy";
import { emitRunCompleted, emitRunFailed, emitRunStarted, emitTurnStart } from "./run-events";
import { runMachine } from "./run-machine";
import { handleCompact, handleContinue, handleError, handleStop } from "./turn-outcome";
import { assertToolExecutor, buildTurn, resolveToolChoice } from "./turn-prepare";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "./lifecycle-dispatch";
import {
  createRunState,
  nonEmptyString,
  requireTrace,
  type AgentRunBase,
  type RunFailureFacts,
} from "./run-state";

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
  const actorId =
    nonEmptyString(input.metadata?.actorId) ?? nonEmptyString(trace.agentName) ?? runId;
  const agentBase = { traceId, sessionId, runId, actorId };
  // Both validators run before the run is opened: `buildPolicyEngine`
  // rejects a malformed middleware registration, and a configuration error
  // must not open a run it cannot close.
  assertToolExecutor(config);
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
  const machine = runMachine();
  const finish = (result: AgentResult): AgentResult => {
    machine.to("completed");
    emitRunCompleted(config.events, state, agentBase, result.finishReason);
    return result;
  };

  /**
   * A throw that never reached a retry decision — nothing decided a reason or
   * a ceiling for it, so the record says what the throw itself can support.
   * Every path that *did* reach one carries the decided facts instead.
   */
  const undecidedFacts = (error: unknown): RunFailureFacts => ({
    reason: Retry.classifyRetryReason(error instanceof Error ? error.message : String(error)),
    attempt,
    maxAttempts: retryPolicy.maxAttempts,
  });

  try {
    machine.to("pre_run");
    const preRunResult = await dispatchPreRun(state, engine, config, agentBase);
    if (preRunResult) return finish(preRunResult);

    for (;;) {
      try {
        const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
          config.model,
        );
        const configuredToolChoice = resolveToolChoice(config);

        for (;;) {
          const budgetResult = await dispatchBudgetCheck(state, engine, config, agentBase);
          if (budgetResult) return finish(budgetResult);

          machine.to("turn_start");
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

          machine.to("awaiting_model");
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

          machine.to("settling");
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

          if (outcome.type === "aborted") throw new Error("aborted");
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
          machine.to("retrying");
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
    machine.to("failed");
    throw error;
  } finally {
    // A `return` that skipped `finish` leaves here, and a throw from a
    // `finally` outranks it — so "started with no terminal" stops being a
    // convention every exit has to remember.
    machine.assertSettled();
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

  const proxyModels = await Provider.listModels(model.provider, "proxy").catch(() => []);
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
