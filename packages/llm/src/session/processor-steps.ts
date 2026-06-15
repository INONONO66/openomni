import type { Message } from "@openomni/protocol";
import { TokenTracker } from "../token";
import type { Provider } from "../provider";
import { generateId, type StreamEvent } from "./processor-types.js";

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
    usage: event.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          inputTokenDetails?: {
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          outputTokenDetails?: {
            reasoningTokens?: number;
          };
          reasoningTokens?: number;
          reasoning_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          raw?: {
            completion_tokens_details?: {
              reasoning_tokens?: number;
            };
          };
        }
      | undefined,
    providerMetadata: event.providerMetadata as
      | {
          anthropic?: {
            reasoningTokens?: number;
            cacheCreationInputTokens?: number;
            cacheReadInputTokens?: number;
          };
          openai?: {
            reasoningTokens?: number;
            cachedPromptTokens?: number;
          };
        }
      | undefined,
  });

  const tokenCost = TokenTracker.calculateCost(
    usage,
    context.model.cost
      ? {
          input: context.model.cost.input,
          output: context.model.cost.output,
          cacheRead: context.model.cost.cache?.read,
          cacheWrite: context.model.cost.cache?.write,
        }
      : undefined,
  );

  context.assistantMessage.finish = finishReason;
  context.assistantMessage.cost += tokenCost.totalCost;
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
    cost: tokenCost.totalCost,
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
