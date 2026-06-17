import type { Message } from "@openomni/protocol";
import type { ModelMessage } from "ai";
import { type Provider, ProviderTransform } from "../provider";

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

function buildAssistantReasoningBlock(content: string): AssistantReasoningBlock {
  return { type: "reasoning", text: content };
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
      // Skip error messages (aborted, auth errors, etc.)
      if ("error" in msg.info && msg.info.error) continue;

      const textContent: string[] = [];
      const reasoningContent: string[] = [];
      const toolCalls: AssistantToolCallBlock[] = [];
      const toolResults: ToolMessage[] = [];

      for (const part of msg.parts) {
        if (part.type === "text") {
          textContent.push(part.text);
        }

        if (part.type === "reasoning") {
          reasoningContent.push(part.text);
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

      if (toolCalls.length > 0) {
        // Assistant message with tool calls
        const assistantContent: Array<
          AssistantTextBlock | AssistantReasoningBlock | AssistantToolCallBlock
        > = [];

        if (textContent.length > 0) {
          assistantContent.push(buildAssistantTextBlock(textContent.join("\n")));
        }
        if (reasoningContent.length > 0) {
          assistantContent.push(buildAssistantReasoningBlock(reasoningContent.join("\n")));
        }
        assistantContent.push(...toolCalls);

        coreMessages.push(buildAssistantBlock(assistantContent));

        // Add tool results
        for (const result of toolResults) {
          coreMessages.push(result);
        }
      } else if (textContent.length > 0) {
        if (reasoningContent.length > 0) {
          coreMessages.push(
            buildAssistantBlock([
              buildAssistantTextBlock(textContent.join("\n")),
              buildAssistantReasoningBlock(reasoningContent.join("\n")),
            ]),
          );
        } else {
          coreMessages.push(buildAssistantBlock(textContent.join("\n")));
        }
      } else if (reasoningContent.length > 0) {
        coreMessages.push(
          buildAssistantBlock([buildAssistantReasoningBlock(reasoningContent.join("\n"))]),
        );
      }
    }
  }

  return ProviderTransform.normalizeMessages(coreMessages, model);
}
