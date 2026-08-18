import { Message } from "@openomni/protocol";
import type { Policy } from "@openomni/protocol";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import type { ChatAgentConfig } from "../types";
import { appendRunMessages, replaceRunMessages, type RunState } from "./state";

export function effectOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Extract<Policy.PolicyEffect, { type: T }> | undefined {
  return decision.effects.find(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

export function effectsOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Array<Extract<Policy.PolicyEffect, { type: T }>> {
  return decision.effects.filter(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(`${pattern.slice(0, -2)}.`);
  return toolName === pattern;
}

export namespace PolicyEffectApplier {
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
            : createUserMessage(effect.message, sessionId, { policyInjected: true });
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
    state: RunState,
    decision: Policy.PolicyDecision,
  ): void {
    const messages: Message.WithParts[] = [];
    let parentID = state.messages.at(-1)?.info.id ?? "";
    for (const effect of decision.effects) {
      if (effect.type === "prompt.inject_message") {
        const message =
          effect.role === "assistant"
            ? createAssistantMessage(effect.message, parentID, state.sessionId)
            : createUserMessage(effect.message, state.sessionId, { policyInjected: true });
        messages.push(message);
        parentID = message.info.id;
      } else if (effect.type === "prompt.append_context") {
        const message = createUserMessage(effect.context, state.sessionId);
        messages.push(message);
        parentID = message.info.id;
      }
    }
    appendRunMessages(state, messages);
  }

  export function applyMessageReplacementEffect(
    state: RunState,
    decision: Policy.PolicyDecision,
  ): void {
    const messages = replacementMessages(decision);
    if (messages !== undefined) replaceRunMessages(state, messages);
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
