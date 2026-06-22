import type { Message } from "@openomni/protocol";
import { TokenTracker } from "../token";
import type { Provider } from "../provider";
import { generateId, type StreamEvent } from "./contracts.js";

export type StepEventContext = {
  readonly sessionID: string;
  readonly assistantMessage: Message.AssistantMessage;
  readonly model: Provider.Model;
  readonly messagePartWriter: {
    add(part: Message.Part): void;
  };
};

export function addStepStart(context: StepEventContext): void {
  context.messagePartWriter.add({
    id: generateId(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "step-start",
  });
}

export function addStepFinish(event: StreamEvent, context: StepEventContext): void {
  const finishReason = String(event.finishReason || "end_turn");
  const usage = TokenTracker.extractUsage({
    usage: event.usage,
    providerMetadata: event.providerMetadata,
  });

  context.assistantMessage.finish = finishReason;
  context.assistantMessage.tokens.input += usage.inputTokens;
  context.assistantMessage.tokens.output += usage.outputTokens;
  context.assistantMessage.tokens.reasoning += usage.reasoningTokens ?? 0;
  context.assistantMessage.tokens.cache.read += usage.cacheReadTokens ?? 0;
  context.assistantMessage.tokens.cache.write += usage.cacheWriteTokens ?? 0;

  context.messagePartWriter.add({
    id: generateId(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "step-finish",
    reason: finishReason,
    cost: 0,
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      reasoning: usage.reasoningTokens ?? 0,
      cache: {
        read: usage.cacheReadTokens ?? 0,
        write: usage.cacheWriteTokens ?? 0,
      },
    },
  });
}
