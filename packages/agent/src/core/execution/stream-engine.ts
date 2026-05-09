import { run as llmRun, Retry } from "@openomni/llm";
import type { Sink } from "@openomni/protocol";
import { Log, TraceContext } from "@openomni/session";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../types";
import { resolveProviderModel } from "./shared";
import {
  assertToolExecutor,
  buildPolicyEngine,
  buildTurn,
  createStreamRunState,
  dispatchBudgetCheck,
  dispatchPreRun,
  emitTurnStart,
  handleCompact,
  handleContinue,
  handleError,
  handleStop,
  resolveToolChoice,
} from "./stream-helpers";

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
  const retryPolicy = Retry.DEFAULT_AGENT_RETRY_POLICY;
  let attempt = 1;
  let lastError = "";

  const trace = input.traceContext ?? TraceContext.empty();
  const log = Log.withContext({ traceId: trace.traceId, sessionId: trace.sessionId });
  const agentBase = {
    traceId: trace.traceId,
    sessionId: trace.sessionId ?? "",
    runId: trace.runId,
  };
  log.info("agent.run.started", { model: config.model.id });

  while (attempt <= retryPolicy.maxAttempts) {
    const state = createStreamRunState(input);
    const engine = buildPolicyEngine(config, agentBase);
    try {
      const providerModel = await (config.llm?.resolveProviderModel ?? resolveProviderModel)(
        config.model,
      );
      const configuredToolChoice = resolveToolChoice(config);
      assertToolExecutor(config);

      const preRunEvent = await dispatchPreRun(state, engine, config);
      if (preRunEvent) {
        yield preRunEvent;
        return;
      }

      while (true) {
        const budgetEvent = await dispatchBudgetCheck(state, engine, config, log);
        if (budgetEvent) {
          yield budgetEvent;
          return;
        }

        emitTurnStart(state, config, agentBase, log);
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
        const outcome = await runLlm(turnResult.turn.runInput, turnResult.turn.trackingSink);

        if (outcome.type === "stop") {
          const decision = yield* handleStop(
            state,
            config,
            engine,
            agentBase,
            log,
            turnResult.turn,
          );
          if (decision === "continue") continue;
          return;
        }

        if (outcome.type === "continue") {
          yield* handleContinue(state, config, agentBase, log, turnResult.turn.turnUsage);
          continue;
        }

        if (outcome.type === "compact") {
          await handleCompact(state, engine, config, agentBase);
          continue;
        }

        if (outcome.type === "aborted") throw new Error("aborted");
        if (outcome.type === "error") throw new Error(outcome.error.message);
        const _exhaustive: never = outcome;
        throw new Error(`Unknown outcome type: ${(_exhaustive as { type?: string }).type}`);
      }
    } catch (error) {
      const decision = yield* handleError(
        state,
        engine,
        config,
        agentBase,
        log,
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
