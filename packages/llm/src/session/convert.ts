import type { CoreMessage } from "ai";
import { Message } from "./message";
import { Provider, ProviderTransform } from "../provider";

export function toModelMessages(
  messagesWithParts: Message.WithParts[],
  model: Provider.Model,
): CoreMessage[] {
  const coreMessages: CoreMessage[] = [];

  for (const msg of messagesWithParts) {
    if (msg.parts.length === 0) continue;

    if (msg.info.role === "user") {
      const textParts = msg.parts.filter((p): p is Message.TextPart => p.type === "text");
      const content = textParts.map((p) => p.text).join("\n");
      if (content.length > 0) {
        coreMessages.push({
          role: "user",
          content,
        });
      }
    }

    if (msg.info.role === "assistant") {
      // Skip error messages (aborted, auth errors, etc.)
      if ("error" in msg.info && msg.info.error) continue;

      const textContent: string[] = [];
      const toolCalls: Array<{
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }> = [];
      const toolResults: Array<{
        role: "tool";
        content: Array<{
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          result: unknown;
        }>;
      }> = [];

      for (const part of msg.parts) {
        if (part.type === "text") {
          textContent.push(part.text);
        }

        if (part.type === "tool") {
          toolCalls.push({
            type: "tool-call",
            toolCallId: part.callID,
            toolName: part.tool,
            args: part.state.input,
          });

          if (part.state.status === "completed") {
            toolResults.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: part.callID,
                  toolName: part.tool,
                  result: part.state.output,
                },
              ],
            });
          } else if (part.state.status === "error") {
            toolResults.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: part.callID,
                  toolName: part.tool,
                  result: `Error: ${part.state.error}`,
                },
              ],
            });
          } else {
            // pending/running — interrupted
            toolResults.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: part.callID,
                  toolName: part.tool,
                  result: "[Tool execution was interrupted]",
                },
              ],
            });
          }
        }
      }

      if (toolCalls.length > 0) {
        // Assistant message with tool calls
        const assistantContent: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              args: Record<string, unknown>;
            }
        > = [];

        if (textContent.length > 0) {
          assistantContent.push({
            type: "text",
            text: textContent.join("\n"),
          });
        }
        assistantContent.push(...toolCalls);

        coreMessages.push({
          role: "assistant",
          content: assistantContent,
        });

        // Add tool results
        for (const result of toolResults) {
          coreMessages.push(result);
        }
      } else if (textContent.length > 0) {
        coreMessages.push({
          role: "assistant",
          content: textContent.join("\n"),
        });
      }
    }
  }

  return ProviderTransform.normalizeMessages(coreMessages, model);
}
