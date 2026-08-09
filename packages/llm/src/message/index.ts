import type { Message } from "@openomni/protocol";
import type { ModelMessage } from "ai";
import type { Provider } from "../provider";
import { ProviderTransform } from "../provider/transform";

export type SDKMessage = ModelMessage;
type AssistantMessage = Extract<SDKMessage, { role: "assistant" }>;
type ToolMessage = Extract<SDKMessage, { role: "tool" }>;
type AssistantContentBlock = Exclude<AssistantMessage["content"], string>[number];
type AssistantTextBlock = Extract<AssistantContentBlock, { type: "text" }>;
type AssistantReasoningBlock = Extract<AssistantContentBlock, { type: "reasoning" }>;
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "tool-call" }>;
type ToolResultBlock = Extract<ToolMessage["content"][number], { type: "tool-result" }>;

function buildUserBlock(content: string): Extract<SDKMessage, { role: "user" }> {
  return { role: "user", content };
}

function buildAssistantTextBlock(content: string): AssistantTextBlock {
  return { type: "text", text: content };
}

/**
 * #532 candidate 10: the provider reasoning signature is only valid for the
 * exact model that produced it, so it is resent only when the outgoing
 * request's {providerID, modelID} match the pair stored on the message. The
 * message stores no third "api" field, so this double check is the honest
 * available check. The `anthropic` providerOptions namespace is the resend
 * mechanism of @ai-sdk/anthropic (the only provider emitting signatures
 * today); other providers ignore the foreign namespace.
 */
function buildAssistantReasoningBlock(
  part: Message.ReasoningPart,
  resendSignature: boolean,
): AssistantReasoningBlock {
  if (resendSignature && part.signature !== undefined) {
    return {
      type: "reasoning",
      text: part.text,
      providerOptions: { anthropic: { signature: part.signature } },
    };
  }
  return { type: "reasoning", text: part.text };
}

function buildToolCallBlock(call: {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}): AssistantToolCallBlock {
  return {
    type: "tool-call",
    toolCallId: call.id,
    toolName: call.tool,
    input: call.input,
    providerExecuted: false,
  };
}

function buildAssistantBlock(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content };
}

function buildToolResultBlock(result: {
  id: string;
  tool: string;
  output: string;
}): ToolResultBlock {
  return {
    type: "tool-result",
    toolCallId: result.id,
    toolName: result.tool,
    output: { type: "text", value: result.output },
  };
}

function buildToolBlock(content: ToolResultBlock[]): ToolMessage {
  return { role: "tool", content };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

export function toModelMessages(
  messagesWithParts: Message.WithParts[],
  model: Provider.Model,
): SDKMessage[] {
  const coreMessages: SDKMessage[] = [];

  for (const msg of messagesWithParts) {
    if (msg.parts.length === 0) continue;

    if (msg.info.role === "user") {
      const textParts = msg.parts.filter((p): p is Message.TextPart => p.type === "text");
      const content = textParts.map((p) => p.text).join("\n");
      if (content.length > 0) {
        coreMessages.push(buildUserBlock(content));
      }
    }

    if (msg.info.role === "assistant") {
      // Skip error-finished turns from replay: an attempt that closed with
      // finish:"error" (#545 message.finished projection) never produced a
      // durable assistant turn the provider should see again.
      if (msg.info.finish === "error") continue;

      const resendSignature =
        msg.info.providerID === model.providerID && msg.info.modelID === model.id;

      const textContent: string[] = [];
      const reasoningBlocks: AssistantReasoningBlock[] = [];
      const toolCalls: AssistantToolCallBlock[] = [];
      const toolResults: ToolMessage[] = [];

      for (const part of msg.parts) {
        if (part.type === "text") {
          textContent.push(part.text);
        }

        if (part.type === "reasoning") {
          reasoningBlocks.push(buildAssistantReasoningBlock(part, resendSignature));
        }

        if (part.type === "tool") {
          toolCalls.push(
            buildToolCallBlock({
              id: part.callID,
              tool: part.tool,
              input: part.state.input,
            }),
          );

          if (part.state.status === "completed") {
            toolResults.push(
              buildToolBlock([
                buildToolResultBlock({
                  id: part.callID,
                  tool: part.tool,
                  output: stringifyToolOutput(part.state.output),
                }),
              ]),
            );
          } else if (part.state.status === "error") {
            toolResults.push(
              buildToolBlock([
                buildToolResultBlock({
                  id: part.callID,
                  tool: part.tool,
                  output: `Error: ${part.state.error}`,
                }),
              ]),
            );
          } else {
            // pending/running — interrupted
            toolResults.push(
              buildToolBlock([
                buildToolResultBlock({
                  id: part.callID,
                  tool: part.tool,
                  output: "[Tool execution was interrupted]",
                }),
              ]),
            );
          }
        }
      }

      // Reasoning blocks must precede text/tool-call blocks: Anthropic rejects
      // assistant turns where a thinking block follows other content. Each
      // reasoning part stays its own block — signatures are per-block.
      if (toolCalls.length > 0) {
        const assistantContent: Array<
          AssistantTextBlock | AssistantReasoningBlock | AssistantToolCallBlock
        > = [...reasoningBlocks];

        if (textContent.length > 0) {
          assistantContent.push(buildAssistantTextBlock(textContent.join("\n")));
        }
        assistantContent.push(...toolCalls);

        coreMessages.push(buildAssistantBlock(assistantContent));

        for (const result of toolResults) {
          coreMessages.push(result);
        }
      } else if (reasoningBlocks.length > 0) {
        const assistantContent: Array<AssistantTextBlock | AssistantReasoningBlock> = [
          ...reasoningBlocks,
        ];
        if (textContent.length > 0) {
          assistantContent.push(buildAssistantTextBlock(textContent.join("\n")));
        }
        coreMessages.push(buildAssistantBlock(assistantContent));
      } else if (textContent.length > 0) {
        coreMessages.push(buildAssistantBlock(textContent.join("\n")));
      }
    }
  }

  return ProviderTransform.normalizeMessages(coreMessages, model);
}
