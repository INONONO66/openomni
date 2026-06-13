import type { ChatAgent } from "@openomni/agent";
import type { Message, Tool } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { type RuntimeMessage, addTextPart } from "./shared";

function createCompletedToolState(call: Tool.Call, output: string): Tool.StateCompleted {
  const now = Date.now();
  return {
    status: "completed",
    input: call.input,
    output,
    title: call.tool,
    metadata: {},
    time: {
      start: now,
      end: now,
    },
  };
}

function createErrorToolState(call: Tool.Call, error: string): Tool.StateError {
  const now = Date.now();
  return {
    status: "error",
    input: call.input,
    error,
    time: {
      start: now,
      end: now,
    },
  };
}

function addToolParts(
  sessionId: string,
  messageId: string,
  steps: { toolCalls?: Tool.Call[]; toolResults?: Tool.Result[] }[],
): void {
  for (const step of steps) {
    if (!step.toolCalls || !step.toolResults) {
      continue;
    }

    const resultsByCallId = new Map(step.toolResults.map((result) => [result.toolCallId, result]));
    for (const call of step.toolCalls) {
      const result = resultsByCallId.get(call.id);
      if (!result) {
        continue;
      }

      const part: Message.ToolPart = {
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: call.id,
        tool: call.tool,
        state: result.isError
          ? createErrorToolState(call, result.output)
          : createCompletedToolState(call, result.output),
      };
      Session.addPart(messageId, part);
    }
  }
}

function serializeToolPart(part: Message.ToolPart, repair?: boolean): string {
  const input = JSON.stringify(part.state.input);

  switch (part.state.status) {
    case "completed":
      return `[Tool: ${part.tool}] Input: ${input} Output: ${part.state.output}`;
    case "error":
      return `[Tool: ${part.tool}] Input: ${input} Output: ${part.state.error}`;
    case "pending":
    case "running":
      if (repair) {
        return `[Tool: ${part.tool}] Error: tool execution interrupted (synthetic)`;
      }
      return `[Tool: ${part.tool}] Input: ${input} Output: (${part.state.status})`;
  }
}

export function addAssistantResultParts(
  sessionId: string,
  messageId: string,
  result: Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>,
): void {
  addTextPart(sessionId, messageId, result.text);
  addToolParts(sessionId, messageId, result.steps);
}

function toRuntimeMessage(
  message: Message.WithParts,
  repair?: boolean,
): RuntimeMessage | undefined {
  if (message.info.role !== "user" && message.info.role !== "assistant") {
    return undefined;
  }

  const content: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      content.push(part.text);
      continue;
    }

    if (part.type === "tool") {
      content.push(serializeToolPart(part, repair));
    }
  }

  if (content.length === 0) {
    return undefined;
  }

  return { role: message.info.role, content: content.join("\n") };
}

export function buildSessionMessagesWithParts(sessionId: string): Message.WithParts[] {
  const result: Message.WithParts[] = [];

  for (const message of Session.getMessages(sessionId)) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const withParts: Message.WithParts = {
      info: message,
      parts: Session.getParts(message.id),
    };

    if (toRuntimeMessage(withParts) !== undefined) {
      result.push(withParts);
    }
  }

  return result;
}

export function buildRuntimeMessages(
  messages: Message.WithParts[],
  repair?: boolean,
): RuntimeMessage[] {
  const result: RuntimeMessage[] = [];

  for (const message of messages) {
    const runtimeMessage = toRuntimeMessage(message, repair);
    if (runtimeMessage) {
      result.push(runtimeMessage);
    }
  }

  return result;
}

export function estimateRuntimeTokens(messages: RuntimeMessage[]): number {
  return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
}
