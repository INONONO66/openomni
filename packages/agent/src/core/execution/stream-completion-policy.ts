import { type Message, PolicyDecision } from "@openomni/protocol";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig } from "../types";
import { emitCompaction, publishDenyDiagnostic } from "./stream-events";
import { StreamPolicyEffects } from "./stream-policy-effects";
import { buildLifecyclePolicyContext } from "./stream-policy-context";
import { createGuardCompleteEvent, errorMessage } from "./stream-result";
import { applyCompactionMessages, type StreamAgentBase, type StreamRunState } from "./stream-state";

export async function dispatchPostRunTransform(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
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
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
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
    messages = StreamPolicyEffects.replacementMessages(compactionDecision);
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
  StreamPolicyEffects.applyPromptMessageEffects(state, compactionDecision);

  return null;
}
