import { PolicyDecision, type Run } from "@openomni/protocol";
import { effectOf, PolicyEffectApplier } from "./policy-effects";
import { publishBudgetTelemetry } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { AgentResult, ChatAgentConfig } from "../types";
import { guardAbortedResult, runResult, publishDenyDiagnostic } from "./run-events";
import { buildLifecyclePolicyContext, type AgentRunBase, type RunState } from "./run-state";

export async function dispatchPreRun(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<AgentResult | null> {
  const preRunDecision = await engine.dispatchPoint(
    "run.lifecycle.pre",
    buildLifecyclePolicyContext(state, config, agentBase, {
      turnCount: 0,
      continuationCount: 0,
      elapsedMs: 0,
    }),
  );

  if (PolicyDecision.isBlocking(preRunDecision)) {
    return guardAbortedResult(state, { text: "", steps: [] });
  }

  PolicyEffectApplier.applyPromptMessageEffects(state, preRunDecision);
  return null;
}

export async function dispatchBudgetCheck(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<AgentResult | null> {
  // The single per-turn owner of budget telemetry: emit here (command) and act
  // on the returned status. The budget nudges — openomni's, since D5 — read
  // the same status through the pure checkBudget query at run.turn.pre, so the
  // event is not re-emitted per policy.
  const budgetStatus = publishBudgetTelemetry(
    state.budgetState,
    agentBase,
    config.events,
    config.budget,
  );
  if (budgetStatus !== "exceeded") return null;

  const postRunDecision = await engine.dispatchPoint(
    "run.lifecycle.post",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion: true,
      runOutcome: { type: "max-steps" },
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic(config.events, "run.finish", postRunDecision, state, agentBase);
  }
  return runResult(state, { finishReason: "max-steps" });
}

type ModelResponseFacts = {
  readonly outcome: Run.Outcome;
  readonly responseTokens: number;
};

export async function dispatchModelRequest(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<AgentResult | null> {
  const decision = await engine.dispatchPoint(
    "connection.llm.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { modelId: config.model.id }),
  );

  if (PolicyDecision.isBlocking(decision)) return guardAbortedResult(state);
  PolicyEffectApplier.applyPromptMessageEffects(state, decision);
  return null;
}

export async function dispatchModelResponse(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  response: ModelResponseFacts,
  agentBase: AgentRunBase,
): Promise<AgentResult | null> {
  const decision = await engine.dispatchPoint(
    "connection.llm.post",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion: response.outcome.type === "stop",
      toolInput: { outcomeType: response.outcome.type },
      modelId: config.model.id,
      responseTokens: response.responseTokens,
    }),
  );

  if (!PolicyDecision.isBlocking(decision)) {
    try {
      PolicyEffectApplier.applyMessageReplacementEffect(state, decision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      publishDenyDiagnostic(
        config.events,
        "model.response",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [reason],
          effects: [{ type: "run.abort", reason }],
        }),
        state,
        agentBase,
      );
      return guardAbortedResult(state);
    }
    PolicyEffectApplier.applyPromptMessageEffects(state, decision);
    return null;
  }
  if (effectOf(decision, "run.abort")) return guardAbortedResult(state);
  // model.response is post-boundary: plain denies are diagnostics unless they carry run.abort.
  publishDenyDiagnostic(config.events, "model.response", decision, state, agentBase);
  return null;
}
