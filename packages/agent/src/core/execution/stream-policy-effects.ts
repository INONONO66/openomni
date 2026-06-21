import { Message } from "@openomni/protocol";
import type { Policy } from "@openomni/protocol";
import { effectOf, effectsOf, matchesToolPattern } from "./policy-effects";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import type { ChatAgentConfig } from "../types";
import { appendStreamMessages, replaceStreamMessages, type StreamRunState } from "./stream-state";

export namespace StreamPolicyEffects {
  export function continuationMessages(
    decision: Policy.PolicyDecision,
    sessionId: string,
    parentID: string,
  ): Message.WithParts[] {
    const messages: Message.WithParts[] = [];
    let assistantParentID = parentID;
    for (const effect of decision.effects) {
      if (effect.type === "prompt.inject_message") {
        const message =
          effect.role === "assistant"
            ? createAssistantMessage(effect.message, assistantParentID, sessionId)
            : createUserMessage(effect.message, sessionId);
        messages.push(message);
        assistantParentID = message.info.id;
      } else if (effect.type === "run.continue_with_prompt") {
        messages.push(createUserMessage(effect.prompt, sessionId));
      }
    }
    return messages;
  }

  export function replacementMessages(
    decision: Policy.PolicyDecision,
  ): Message.WithParts[] | undefined {
    const effect = effectOf(decision, "run.replace_messages");
    if (!effect) return undefined;

    const parsed = Message.WithParts.array().safeParse(effect.messages);
    if (!parsed.success) {
      throw new Error("policy.invalid_replacement_messages");
    }
    return parsed.data;
  }

  export function applyPromptMessageEffects(
    state: StreamRunState,
    decision: Policy.PolicyDecision,
  ): void {
    const messages: Message.WithParts[] = [];
    for (const effect of decision.effects) {
      if (effect.type === "prompt.inject_message") {
        const parentID = state.messages.at(-1)?.info.id ?? "";
        messages.push(
          effect.role === "assistant"
            ? createAssistantMessage(effect.message, parentID, state.sessionId)
            : createUserMessage(effect.message, state.sessionId),
        );
      } else if (effect.type === "prompt.append_context") {
        messages.push(createUserMessage(effect.context, state.sessionId));
      }
    }
    appendStreamMessages(state, messages);
  }

  export function applyMessageReplacementEffect(
    state: StreamRunState,
    decision: Policy.PolicyDecision,
  ): void {
    const messages = replacementMessages(decision);
    if (messages !== undefined) replaceStreamMessages(state, messages);
  }

  export function applyToolFilterEffects(
    tools: NonNullable<ChatAgentConfig["tools"]>,
    decision: Policy.PolicyDecision,
  ): NonNullable<ChatAgentConfig["tools"]> {
    const filters = effectsOf(decision, "tool.filter");
    if (filters.length === 0) return tools;
    return tools.filter(
      (tool) => !filters.some((effect) => matchesToolPattern(tool.name, effect.toolPattern)),
    );
  }
}
