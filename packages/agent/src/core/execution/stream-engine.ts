import { run as llmRun } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
import { TraceContext } from "@openomni/session";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../types";
import * as Retry from "../retry";
import { resolveProviderModel } from "./shared";
import { emitRunStarted, emitTurnStart } from "./stream-events";
import { handleCompact, handleContinue, handleError, handleStop } from "./stream-flow";
import { assertToolExecutor, buildTurn, resolveToolChoice } from "./stream-turn";
import { buildPolicyEngine } from "./stream-policy-engine";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "./stream-policy-dispatch";
import { createStreamRunState } from "./stream-state";

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
  const retryPolicy = Retry.DEFAULT_AGENT_RETRY_POLICY;
  let attempt = 1;
  let lastError = "";

  const trace = input.traceContext ?? TraceContext.empty();
  const agentBase = {
    traceId: trace.traceId,
    sessionId: trace.sessionId ?? "",
    runId: trace.runId,
  };
  emitRunStarted(trace, config.model.id);
  assertToolExecutor(config);

  while (attempt <= retryPolicy.maxAttempts) {
    const state = createStreamRunState(input);
    const engine = buildPolicyEngine(config, agentBase);
    try {
      const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
        config.model,
      );
      const configuredToolChoice = resolveToolChoice(config);

      const preRunEvent = await dispatchPreRun(state, engine, config);
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
        const modelRequestEvent = await dispatchModelRequest(state, engine, config);
        if (modelRequestEvent) {
          yield modelRequestEvent;
          return;
        }
        const outcome = await runLlm(turnResult.turn.runInput, turnResult.turn.trackingSink);
        const modelResponseEvent = await dispatchModelResponse(
          state,
          engine,
          config,
          outcome.type,
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
