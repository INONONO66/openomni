import { type Message, PolicyDecision } from "@openomni/protocol";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig } from "../types";
import { emitCompaction, publishDenyDiagnostic } from "./run-events";
import { PolicyEffectApplier } from "./policy-effects-apply";
import { buildLifecyclePolicyContext } from "./lifecycle-context";
import { createGuardCompleteEvent, errorMessage } from "./run-result";
import { applyCompactionMessages, type AgentRunBase, type RunState } from "./run-state";

export async function dispatchPostRunTransform(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<void> {
  const postRunDecision = await engine.dispatch(
    "run.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic("run.finish", postRunDecision, state, config, agentBase);
  }
}

export async function applyPostCompaction(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  isCompletion: boolean,
): Promise<AgentEvent | null> {
  const compactionDecision = await engine.dispatch(
    "completion.prepare",
    buildLifecyclePolicyContext(state, config, {
      isCompletion,
    }),
  );

  if (PolicyDecision.isBlocking(compactionDecision)) {
    publishDenyDiagnostic("completion.prepare", compactionDecision, state, config, agentBase);
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }

  let messages: Message.WithParts[] | undefined;
  try {
    messages = PolicyEffectApplier.replacementMessages(compactionDecision);
  } catch (error) {
    const reason = errorMessage(error);
    publishDenyDiagnostic(
      "completion.prepare",
      PolicyDecision.deny({
        policyId: "agent.policy.composed",
        reasonCodes: [reason],
        effects: [{ type: "run.abort", reason }],
      }),
      state,
      config,
      agentBase,
    );
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }
  if (messages !== undefined) {
    const messagesBefore = applyCompactionMessages(state, messages);
    emitCompaction(agentBase, messagesBefore, state.messages.length);
  }
  PolicyEffectApplier.applyPromptMessageEffects(state, compactionDecision);

  return null;
}
