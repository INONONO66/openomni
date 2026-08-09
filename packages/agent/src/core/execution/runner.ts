import { run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
import { Bus, TraceContext } from "@openomni/session";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { PolicyEngine, type PolicyEngineInstance } from "../policy";
import { resolveProviderModel } from "./shared";
import { emitRunStarted, emitTurnStart } from "./run-events";
import { handleCompact, handleContinue, handleError, handleStop } from "./turn-outcome";
import { assertToolExecutor, buildTurn, resolveToolChoice } from "./turn-prepare";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "./lifecycle-dispatch";
import { createRunState, type AgentRunBase } from "./run-state";

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
  const retryPolicy = Retry.DEFAULT_RETRY_POLICY;
  let attempt = 1;
  let lastError = "";

  const trace = input.traceContext ?? TraceContext.empty();
  const traceId = nonEmptyString(trace.traceId) ?? crypto.randomUUID();
  const sessionId = nonEmptyString(trace.sessionId) ?? crypto.randomUUID();
  const runId = nonEmptyString(trace.runId) ?? crypto.randomUUID();
  const agentName = nonEmptyString(trace.agentName);
  const actorId = nonEmptyString(input.metadata?.actorId) ?? agentName ?? runId;
  const resolvedTrace = {
    ...trace,
    traceId,
    sessionId,
    runId,
    agentName,
  };
  const agentBase = { traceId, sessionId, runId, actorId };
  emitRunStarted(resolvedTrace, config.model.id);
  assertToolExecutor(config);

  while (attempt <= retryPolicy.maxAttempts) {
    const state = createRunState({ ...input, traceContext: resolvedTrace });
    const engine = buildPolicyEngine(config, agentBase);
    try {
      const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
        config.model,
      );
      const configuredToolChoice = resolveToolChoice(config);

      const preRunEvent = await dispatchPreRun(state, engine, config, agentBase);
      if (preRunEvent) {
        yield preRunEvent;
        return;
      }

      while (true) {
        const budgetEvent = await dispatchBudgetCheck(state, engine, config, agentBase);
        if (budgetEvent) {
          yield budgetEvent;
          return;
        }

        emitTurnStart(state, config, agentBase);
        const turnResult = await buildTurn(
          state,
          config,
          engine,
          providerModel,
          configuredToolChoice,
          resolvedTrace,
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
          yield* handleContinue(state, config, agentBase, turnResult.turn.turnUsage);
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

// merged from policy-engine-builder.ts (250-LOC split refold: single-importer stage)
export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): PolicyEngineInstance {
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      ...(agentBase.sessionId !== "" && { sessionId: agentBase.sessionId }),
      ...(agentBase.runId !== undefined && { runId: agentBase.runId }),
    },
    auditEmit: Bus.publish,
  });
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}
