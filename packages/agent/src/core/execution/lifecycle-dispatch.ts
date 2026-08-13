import { PolicyDecision, type Run } from "@openomni/protocol";
import { effectOf, PolicyEffectApplier } from "./policy-effects";
import { publishBudgetTelemetry } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig } from "../types";
import {
  createGuardCompleteEvent,
  createRunCompleteEvent,
  emitRunCompleted,
  publishDenyDiagnostic,
} from "./run-events";
import {
  agentBaseForState,
  buildLifecyclePolicyContext,
  type AgentRunBase,
  type RunState,
} from "./run-state";

export async function dispatchPreRun(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase = agentBaseForState(state),
): Promise<AgentEvent | null> {
  const preRunDecision = await engine.dispatchPoint(
    "run.lifecycle.pre",
    buildLifecyclePolicyContext(state, config, agentBase, {
      turnCount: 0,
      continuationCount: 0,
      elapsedMs: 0,
      actorId: agentBase.actorId ?? agentBase.runId ?? agentBase.traceId,
    }),
  );

  if (PolicyDecision.isBlocking(preRunDecision)) {
    return createGuardCompleteEvent(state, { text: "", steps: [] });
  }

  PolicyEffectApplier.applyPromptMessageEffects(state, preRunDecision);
  return null;
}

export async function dispatchBudgetCheck(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase = agentBaseForState(state),
): Promise<AgentEvent | null> {
  // The single per-turn owner of budget telemetry: emit here (command) and act
  // on the returned status. The run.turn.pre budget builtins read the status
  // via the pure checkBudget query, so the event is not re-emitted per policy.
  const budgetStatus = publishBudgetTelemetry(state.budgetState, agentBase, config.budget);
  if (budgetStatus !== "exceeded") return null;

  const postRunDecision = await engine.dispatchPoint(
    "run.lifecycle.post",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion: true,
      runOutcome: { type: "max-steps" },
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic("run.finish", postRunDecision, state, agentBase);
  }
  emitRunCompleted(state, agentBase, "max-steps");
  return createRunCompleteEvent(state, { finishReason: "max-steps" });
}

type ModelResponseFacts = {
  readonly outcome: Run.Outcome;
  readonly responseTokens: number;
};

export async function dispatchModelRequest(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase = agentBaseForState(state),
): Promise<AgentEvent | null> {
  const decision = await engine.dispatchPoint(
    "connection.llm.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { modelId: config.model.id }),
  );

  if (PolicyDecision.isBlocking(decision)) return createGuardCompleteEvent(state);
  PolicyEffectApplier.applyPromptMessageEffects(state, decision);
  return null;
}

export async function dispatchModelResponse(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  response: ModelResponseFacts,
  agentBase: AgentRunBase,
): Promise<AgentEvent | null> {
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
        "model.response",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [reason],
          effects: [{ type: "run.abort", reason }],
        }),
        state,
        agentBase,
      );
      return createGuardCompleteEvent(state);
    }
    PolicyEffectApplier.applyPromptMessageEffects(state, decision);
    return null;
  }
  if (effectOf(decision, "run.abort")) return createGuardCompleteEvent(state);
  // model.response is post-boundary: plain denies are diagnostics unless they carry run.abort.
  publishDenyDiagnostic("model.response", decision, state, agentBase);
  return null;
}
