import { ModelsDev, Provider, run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { PolicyEngine, type PolicyEngineInstance } from "../policy";
import { emitRunStarted, emitTurnStart } from "./run-events";
import { handleCompact, handleContinue, handleError, handleStop } from "./turn-outcome";
import { assertToolExecutor, buildTurn, resolveToolChoice } from "./turn-prepare";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "./lifecycle-dispatch";
import { createRunState, type AgentRunBase, type RunTrace } from "./run-state";

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
  const retryPolicy = Retry.DEFAULT_RETRY_POLICY;
  let attempt = 1;
  let lastError = "";

  const trace = requireRunTrace(input.traceContext);
  const { traceId, sessionId, runId } = trace;
  const actorId =
    nonEmptyString(input.metadata?.actorId) ?? nonEmptyString(trace.agentName) ?? runId;
  const agentBase = { traceId, sessionId, runId, actorId };
  emitRunStarted(trace, config.model.id);
  assertToolExecutor(config);

  // #546: run state and pre-run dispatch are run-scoped, living across
  // attempts — an agent-level retry regenerates only the attempt (turn
  // artifacts), never the history, budget/usage (no double-billing reset),
  // or run.lifecycle.pre effects (prompt injections apply exactly once).
  const state = createRunState({ ...input, traceContext: trace });
  const engine = buildPolicyEngine(config, agentBase);

  const preRunEvent = await dispatchPreRun(state, engine, config, agentBase);
  if (preRunEvent) {
    yield preRunEvent;
    return;
  }

  while (attempt <= retryPolicy.maxAttempts) {
    try {
      const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
        config.model,
      );
      const configuredToolChoice = resolveToolChoice(config);

      while (true) {
        const budgetEvent = await dispatchBudgetCheck(state, engine, config, agentBase);
        if (budgetEvent) {
          yield budgetEvent;
          return;
        }

        emitTurnStart(state, agentBase);
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
        if (turnResult.type === "complete") {
          yield turnResult.event;
          return;
        }
        if (turnResult.budgetReassuranceEvent) yield turnResult.budgetReassuranceEvent;
        if (turnResult.budgetWarningEvent) yield turnResult.budgetWarningEvent;

        const runLlm = config.llm?.run ?? llmRun;
        const modelRequestEvent = await dispatchModelRequest(state, engine, config, agentBase);
        if (modelRequestEvent) {
          yield modelRequestEvent;
          return;
        }
        const outcome = await runLlm(turnResult.turn.runInput, turnResult.turn.trackingSink);
        const modelResponseEvent = await dispatchModelResponse(
          state,
          engine,
          config,
          {
            outcome,
            responseTokens: turnResult.turn.turnUsage.outputTokens,
          },
          agentBase,
        );
        if (modelResponseEvent) {
          yield modelResponseEvent;
          return;
        }

        if (outcome.type === "stop") {
          const decision = yield* handleStop(state, config, engine, agentBase, turnResult.turn);
          if (decision === "continue") continue;
          return;
        }

        if (outcome.type === "continue") {
          yield* handleContinue(state, agentBase, turnResult.turn.turnUsage);
          continue;
        }

        if (outcome.type === "compact") {
          const compactDecision = await handleCompact(state, engine, config, agentBase);
          if (compactDecision !== "continue") {
            yield compactDecision;
            return;
          }
          continue;
        }

        if (outcome.type === "aborted") throw new Error("aborted");
        if (outcome.type === "error") throw new Error(outcome.error.message);
        const _exhaustive: never = outcome;
        throw new Error(`Unknown outcome type: ${unknownOutcomeType(_exhaustive)}`);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const decision = yield* handleError(
        state,
        engine,
        config,
        agentBase,
        error,
        attempt,
        retryPolicy,
      );
      lastError = decision.errorMessage;
      if (decision.action === "retry") {
        attempt += 1;
        continue;
      }
      if (decision.action === "complete") return;
      throw decision.error;
    }
  }

  throw new Error(lastError || "Max retry attempts exceeded");
}

function unknownOutcomeType(value: unknown): string {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return "unknown";
  }

  const type = value.type;
  return typeof type === "string" ? type : "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A run must arrive with an identity. Minting one here — which is what the
 * removed `TraceContext.empty()` plus three `?? crypto.randomUUID()` fallbacks
 * did — produces a run whose every event correlates to nothing, and the caller
 * never learns it forgot.
 *
 * What is required here is inheritance, not wire format. A run must carry the
 * identity of whatever asked for it; whether that identity is expressible as a
 * W3C `traceparent` is enforced by the emitter that puts it on the wire, which
 * is the only place the format matters.
 */
function requireRunTrace(traceContext: ChatAgentInput["traceContext"]): RunTrace {
  const traceId = nonEmptyString(traceContext?.traceId);
  const sessionId = nonEmptyString(traceContext?.sessionId);
  const runId = nonEmptyString(traceContext?.runId);
  if (traceId === undefined || sessionId === undefined || runId === undefined) {
    const missing = [
      traceId === undefined ? "traceId" : undefined,
      sessionId === undefined ? "sessionId" : undefined,
      runId === undefined ? "runId" : undefined,
    ].filter((field): field is string => field !== undefined);
    throw new Error(`agent run requires a trace context with ${missing.join(", ")}`);
  }
  return { ...traceContext, traceId, sessionId, runId };
}

// merged from shared.ts (fragment sweep: single-consumer fn)
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

// merged from policy-engine-builder.ts (250-LOC split refold: single-importer stage)
export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): PolicyEngineInstance {
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      ...(agentBase.runId !== undefined && { runId: agentBase.runId }),
    },
    auditEmit: Bus.publish,
  });
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}
