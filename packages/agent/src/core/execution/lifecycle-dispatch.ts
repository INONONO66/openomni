import { PolicyDecision } from "@openomni/protocol";
import { effectOf } from "./policy-effects";
import { checkBudget } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig } from "../types";
import { emitRunCompleted, publishDenyDiagnostic } from "./run-events";
import { PolicyEffectApplier } from "./policy-effects-apply";
import { buildLifecyclePolicyContext } from "./lifecycle-context";
import { createGuardCompleteEvent, createRunCompleteEvent, errorMessage } from "./run-result";
import type { AgentRunBase, RunState } from "./run-state";

export async function dispatchPreRun(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const preRunDecision = await engine.dispatch(
    "run.start",
    buildLifecyclePolicyContext(state, config, {
      turnCount: 0,
      continuationCount: 0,
      elapsedMs: 0,
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
  agentBase: AgentRunBase,
): Promise<AgentEvent | null> {
  const budgetStatus = checkBudget(state.budgetState, config.budget);
  if (budgetStatus !== "exceeded") return null;

  const postRunDecision = await engine.dispatch(
    "run.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic("run.finish", postRunDecision, state, config, agentBase);
  }
  emitRunCompleted(state, agentBase, "max-steps");
  return createRunCompleteEvent(state, { finishReason: "max-steps" });
}

export async function dispatchModelRequest(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const decision = await engine.dispatch(
    "model.request",
    buildLifecyclePolicyContext(state, config),
  );

  if (PolicyDecision.isBlocking(decision)) return createGuardCompleteEvent(state);
  PolicyEffectApplier.applyPromptMessageEffects(state, decision);
  return null;
}

export async function dispatchModelResponse(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  outcomeType: string,
  agentBase: AgentRunBase,
): Promise<AgentEvent | null> {
  const decision = await engine.dispatch(
    "model.response",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: outcomeType === "stop",
      toolInput: { outcomeType },
    }),
  );

  if (!PolicyDecision.isBlocking(decision)) {
    try {
      PolicyEffectApplier.applyMessageReplacementEffect(state, decision);
    } catch (error) {
      const reason = errorMessage(error);
      publishDenyDiagnostic(
        "model.response",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [reason],
          effects: [{ type: "run.abort", reason }],
        }),
        state,
        config,
        agentBase,
      );
      return createGuardCompleteEvent(state);
    }
    PolicyEffectApplier.applyPromptMessageEffects(state, decision);
    return null;
  }
  if (effectOf(decision, "run.abort")) return createGuardCompleteEvent(state);
  // model.response is post-boundary: plain denies are diagnostics unless they carry run.abort.
  publishDenyDiagnostic("model.response", decision, state, config, agentBase);
  return null;
}
