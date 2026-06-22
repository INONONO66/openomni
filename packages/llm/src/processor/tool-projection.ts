import type { Message, Sink } from "@openomni/protocol";
import { generateId, type StreamEvent, type ToolResult } from "./contracts.js";

export type ToolEventContext = {
  readonly sessionID: string;
  readonly assistantMessage: Message.AssistantMessage;
  readonly sink: Sink;
  readonly pendingTools: Message.ToolPart[];
  readonly messagePartWriter: {
    add(part: Message.Part): void;
    update(part: Message.Part): void;
  };
  readonly onToolCall?: (part: Message.ToolPart) => Promise<ToolResult>;
};

type RunningToolEventContext = Omit<ToolEventContext, "onToolCall"> & {
  readonly onToolCall: (part: Message.ToolPart) => Promise<ToolResult>;
};

export async function handleToolCall(event: StreamEvent, context: ToolEventContext): Promise<void> {
  const input = ((event.input ?? event.args) as Record<string, unknown>) || {};
  const toolPart: Message.ToolPart = {
    id: generateId(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "tool",
    callID: String(event.toolCallId),
    tool: String(event.toolName),
    state: {
      status: "pending",
      input,
    },
  };
  context.messagePartWriter.add(toolPart);
  context.pendingTools.push(toolPart);
  context.sink.onToolCall({
    id: toolPart.callID,
    tool: toolPart.tool,
    input: toolPart.state.input,
  });

  if (!context.onToolCall) return;
  await runToolCall(toolPart, { ...context, onToolCall: context.onToolCall });
}

export function handleToolResult(event: StreamEvent, context: ToolEventContext): void {
  const toolCallId = String(event.toolCallId);
  const toolPart = context.pendingTools.find((pending) => pending.callID === toolCallId);
  const outputPayload = normalizeOutputPayload(event);
  const isError = event.isError === true || outputPayload.isError;

  if (!toolPart) {
    return;
  }

  if (isError) {
    toolPart.state = {
      status: "error",
      input: toolPart.state.input,
      error: outputPayload.output,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    };
  } else {
    toolPart.state = {
      status: "completed",
      input: toolPart.state.input,
      output: outputPayload.output,
      title: String(event.toolName ?? toolPart.tool),
      metadata: {},
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    };
  }

  context.messagePartWriter.update(toolPart);
  context.sink.onToolResult({
    id: generateId(),
    toolCallId,
    output: outputPayload.output,
    ...(isError && { isError: true }),
  });

  const index = context.pendingTools.indexOf(toolPart);
  if (index >= 0) context.pendingTools.splice(index, 1);
}

function normalizeOutputPayload(event: StreamEvent): { output: string; isError: boolean } {
  const raw = event.output;
  if (typeof raw === "object" && raw !== null && "output" in raw) {
    const payload = raw as { output?: unknown; isError?: unknown };
    return {
      output: String(payload.output ?? ""),
      isError: payload.isError === true,
    };
  }
  const fallback = event.error ?? event.message ?? "";
  return {
    output: String(raw ?? fallback),
    isError: false,
  };
}

export function cleanupPendingTools(
  pendingTools: Message.ToolPart[],
  updateMessagePart: (part: Message.Part) => void,
  sink: Sink,
): void {
  for (const tool of pendingTools) {
    if (tool.state.status === "pending" || tool.state.status === "running") {
      tool.state = {
        status: "error",
        input: tool.state.input,
        error: "Processing was interrupted",
        time: {
          start: tool.state.status === "running" ? tool.state.time.start : Date.now(),
          end: Date.now(),
        },
      };
      updateMessagePart(tool);
      sink.onToolResult({
        id: generateId(),
        toolCallId: tool.callID,
        output: "Processing was interrupted",
        isError: true,
      });
    }
  }
}

async function runToolCall(
  toolPart: Message.ToolPart,
  context: RunningToolEventContext,
): Promise<void> {
  toolPart.state = {
    status: "running",
    input: toolPart.state.input,
    time: { start: Date.now() },
  };
  context.messagePartWriter.update(toolPart);

  try {
    const result = await context.onToolCall(toolPart);
    toolPart.state = {
      status: "completed",
      input: toolPart.state.input,
      output: result.output,
      title: result.title,
      metadata: result.metadata ?? {},
      time: {
        start: toolPart.state.status === "running" ? toolPart.state.time.start : Date.now(),
        end: Date.now(),
      },
    };
    context.messagePartWriter.update(toolPart);
    context.sink.onToolResult({
      id: generateId(),
      toolCallId: toolPart.callID,
      output: result.output,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    toolPart.state = {
      status: "error",
      input: toolPart.state.input,
      error: errorMessage,
      time: {
        start: toolPart.state.status === "running" ? toolPart.state.time.start : Date.now(),
        end: Date.now(),
      },
    };
    context.messagePartWriter.update(toolPart);
    context.sink.onToolResult({
      id: generateId(),
      toolCallId: toolPart.callID,
      output: errorMessage,
      isError: true,
    });
  }
  const idx = context.pendingTools.indexOf(toolPart);
  if (idx >= 0) context.pendingTools.splice(idx, 1);
}
