import type { Message } from "./message";
import { type Provider, ProviderTransform } from "../provider";

type SystemMessage = {
  role: "system";
  content: string;
};

type UserMessage = {
  role: "user";
  content: string;
};

type AssistantTextBlock = {
  type: "text";
  text: string;
};

type AssistantToolCallBlock = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type AssistantMessage = {
  role: "assistant";
  content: string | Array<AssistantTextBlock | AssistantToolCallBlock>;
};

type ToolResultBlock = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
};

type ToolMessage = {
  role: "tool";
  content: ToolResultBlock[];
};

export type SDKMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function buildSystemBlock(content: string): SystemMessage {
  return { role: "system", content };
}

export function buildUserBlock(content: string): UserMessage {
  return { role: "user", content };
}

export function buildAssistantTextBlock(content: string): AssistantTextBlock {
  return { type: "text", text: content };
}

export function buildToolCallBlock(call: {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}): AssistantToolCallBlock {
  return {
    type: "tool-call",
    toolCallId: call.id,
    toolName: call.tool,
    input: call.input,
  };
}

export function buildAssistantBlock(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content };
}

export function buildToolResultBlock(result: {
  id: string;
  tool: string;
  output: string;
}): ToolResultBlock {
  return {
    type: "tool-result",
    toolCallId: result.id,
    toolName: result.tool,
    output: result.output,
  };
}

export function buildToolBlock(content: ToolResultBlock[]): ToolMessage {
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
      const toolCalls: AssistantToolCallBlock[] = [];
      const toolResults: ToolMessage[] = [];

      for (const part of msg.parts) {
        if (part.type === "text") {
          textContent.push(part.text);
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
        const assistantContent: Array<AssistantTextBlock | AssistantToolCallBlock> = [];

        if (textContent.length > 0) {
          assistantContent.push(buildAssistantTextBlock(textContent.join("\n")));
        }
        assistantContent.push(...toolCalls);

        coreMessages.push(buildAssistantBlock(assistantContent));

        // Add tool results
        for (const result of toolResults) {
          coreMessages.push(result);
        }
      } else if (textContent.length > 0) {
        coreMessages.push(buildAssistantBlock(textContent.join("\n")));
      }
    }
  }

  return ProviderTransform.normalizeMessages(coreMessages, model);
}
