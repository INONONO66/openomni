import { accumulateUsage, type Sink } from "@openomni/llm";
import { Message, PlainValueSchema } from "@openomni/protocol";
import { measuredContextTokens } from "../../compaction/measure";
import type { ChatAgentConfig, TokenUsage } from "../types";
import {
  recordAssistantTokenDelta,
  recordCallContext,
  setLastAssistantText,
  type RunState,
  type TurnArtifacts,
} from "./state";

export function assistantTextOf(message: Message.WithParts | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .filter((part: Message.Part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function createTrackingSink(
  state: RunState,
  sink: Sink | undefined,
  turnUsage: TokenUsage,
  turnAssistant: TurnArtifacts["turnAssistant"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;
  let previousAux = { reasoning: 0, read: 0, write: 0 };
  return {
    onMessage(message) {
      if (message.info.role === "assistant") {
        // The latest immutable fold snapshot is the turn's only assistant source.
        turnAssistant.message = message;
        const tokens = message.info.tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        const delta = {
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          reasoningTokens: tokens.reasoning - previousAux.reasoning,
          cacheReadTokens: tokens.cache.read - previousAux.read,
          cacheWriteTokens: tokens.cache.write - previousAux.write,
        };
        previousAux = {
          reasoning: tokens.reasoning,
          read: tokens.cache.read,
          write: tokens.cache.write,
        };
        if (
          deltaInput > 0 ||
          deltaOutput > 0 ||
          delta.reasoningTokens > 0 ||
          delta.cacheReadTokens > 0 ||
          delta.cacheWriteTokens > 0
        ) {
          accumulateUsage(turnUsage, delta);
          recordAssistantTokenDelta(state, delta);
          const measured = measuredContextTokens(message);
          if (measured !== undefined) recordCallContext(state, measured);
        }
      }
      const text = assistantTextOf(message);
      if (text) setLastAssistantText(state, text);
      sink?.onMessage(message);
    },
    onToolCall: (call) => sink?.onToolCall(call),
    onToolResult: (result) => sink?.onToolResult(result),
  };
}

export async function recordAssistant(
  config: ChatAgentConfig,
  message: Message.WithParts,
): Promise<Message.WithParts> {
  if (config.executor === undefined) throw new Error("missing message authority");
  const result = await config.executor.run(
    { kind: "message", op: "assistant", intent: { messageId: message.info.id }, effect: {} },
    async () => PlainValueSchema.parse(message),
  );
  if (result.terminal !== "executed")
    throw new Error(`assistant persistence refused: ${result.reason}`);
  return Message.WithParts.parse(result.value);
}
