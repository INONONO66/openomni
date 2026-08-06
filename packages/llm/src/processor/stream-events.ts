import type { Message, Sink } from "@openomni/protocol";
import { TokenTracker } from "../token";

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

type MessagePartWriter = {
  add(part: Message.Part): void;
  update(part: Message.Part): void;
};

export type StreamEventContext = {
  readonly sessionID: string;
  readonly assistantMessage: Message.AssistantMessage;
  readonly sink: Sink;
  readonly pendingTools: Message.ToolPart[];
  readonly messagePartWriter: MessagePartWriter;
};

type StreamEventState = {
  currentText?: Message.TextPart;
  reasoningMap: Record<string, Message.ReasoningPart>;
};

export function createStreamEventState(): StreamEventState {
  return { reasoningMap: {} };
}

export function handleStreamEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  switch (event.type) {
    case "text-start": {
      startText(event, state, context);
      break;
    }
    case "text-delta": {
      appendText(event, state, context);
      break;
    }
    case "text-end": {
      finishText(event, state, context);
      break;
    }
    case "reasoning-start": {
      startReasoning(event, state, context);
      break;
    }
    case "reasoning-delta": {
      appendReasoning(event, state, context);
      break;
    }
    case "reasoning-end": {
      finishReasoning(event, state, context);
      break;
    }
    case "tool-call": {
      handleToolCall(event, context);
      break;
    }
    case "tool-result": {
      handleToolResult(event, context);
      break;
    }
    case "tool-error": {
      handleToolResult({ ...event, type: "tool-result", isError: true }, context);
      break;
    }
    case "step-start": {
      addStepStart(context);
      break;
    }
    case "step-finish": {
      addStepFinish(event, context);
      break;
    }
    case "finish": {
      break;
    }
    case "error": {
      throw event.error;
    }
    default: {
      break;
    }
  }
}

function startText(event: StreamEvent, state: StreamEventState, context: StreamEventContext): void {
  state.currentText = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "text",
    text: "",
    time: { start: Date.now() },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  context.messagePartWriter.add(state.currentText);
}

// Handlers publish copy-on-write part objects: a published part is never
// mutated afterwards, so sink consumers holding earlier snapshots see the
// state at publish time, not the final state.
function appendText(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  if (!state.currentText) return;
  const updated: Message.TextPart = {
    ...state.currentText,
    text: state.currentText.text + String(event.text || ""),
    ...(event.providerMetadata !== undefined && {
      metadata: event.providerMetadata as Record<string, unknown>,
    }),
  };
  state.currentText = updated;
  context.messagePartWriter.update(updated);
}

function finishText(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const current = state.currentText;
  if (current?.time) {
    const updated: Message.TextPart = {
      ...current,
      text: current.text.trimEnd(),
      time: { start: current.time.start, end: Date.now() },
      ...(event.providerMetadata !== undefined && {
        metadata: event.providerMetadata as Record<string, unknown>,
      }),
    };
    context.messagePartWriter.update(updated);
  }
  state.currentText = undefined;
}

function startReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  if (reasoningId in state.reasoningMap) return;
  const part: Message.ReasoningPart = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "reasoning",
    text: "",
    time: { start: Date.now(), end: undefined },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  state.reasoningMap[reasoningId] = part;
  context.messagePartWriter.add(part);
}

function appendReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  const part = state.reasoningMap[reasoningId];
  if (part == null) return;
  const updated: Message.ReasoningPart = {
    ...part,
    text: part.text + String(event.text || ""),
    ...(event.providerMetadata !== undefined && {
      metadata: event.providerMetadata as Record<string, unknown>,
    }),
  };
  state.reasoningMap[reasoningId] = updated;
  context.messagePartWriter.update(updated);
}

function finishReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  const part = state.reasoningMap[reasoningId];
  if (part == null) return;
  const updated: Message.ReasoningPart = {
    ...part,
    text: part.text.trimEnd(),
    time: {
      start: part.time?.start ?? Date.now(),
      end: Date.now(),
    },
    ...(event.providerMetadata !== undefined && {
      metadata: event.providerMetadata as Record<string, unknown>,
    }),
  };
  context.messagePartWriter.update(updated);
  delete state.reasoningMap[reasoningId];
}

function handleToolCall(event: StreamEvent, context: StreamEventContext): void {
  const input = ((event.input ?? event.args) as Record<string, unknown>) || {};
  const toolPart: Message.ToolPart = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "tool",
    callID: String(event.toolCallId),
    tool: String(event.toolName),
    // The AI SDK executes the tool between tool-call and tool-result, so the
    // call event is the execution start: record it here so the result can
    // report a real duration.
    state: {
      status: "running",
      input,
      time: { start: Date.now() },
    },
  };
  context.messagePartWriter.add(toolPart);
  context.pendingTools.push(toolPart);
  context.sink.onToolCall({
    id: toolPart.callID,
    tool: toolPart.tool,
    input: toolPart.state.input,
  });
}

function handleToolResult(event: StreamEvent, context: StreamEventContext): void {
  const toolCallId = String(event.toolCallId);
  const toolPart = context.pendingTools.find((pending) => pending.callID === toolCallId);
  if (!toolPart) return;

  const outputPayload = normalizeOutputPayload(event);
  const isError = event.isError === true || outputPayload.isError;
  const start = toolPart.state.status === "running" ? toolPart.state.time.start : Date.now();

  const updated: Message.ToolPart = {
    ...toolPart,
    state: isError
      ? {
          status: "error",
          input: toolPart.state.input,
          error: outputPayload.output,
          time: { start, end: Date.now() },
        }
      : {
          status: "completed",
          input: toolPart.state.input,
          output: outputPayload.output,
          title: String(event.toolName ?? toolPart.tool),
          metadata: {},
          time: { start, end: Date.now() },
        },
  };

  context.messagePartWriter.update(updated);
  context.sink.onToolResult({
    id: crypto.randomUUID(),
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
    if (tool.state.status !== "pending" && tool.state.status !== "running") continue;
    const start = tool.state.status === "running" ? tool.state.time.start : Date.now();
    updateMessagePart({
      ...tool,
      state: {
        status: "error",
        input: tool.state.input,
        error: "Processing was interrupted",
        time: { start, end: Date.now() },
      },
    });
    sink.onToolResult({
      id: crypto.randomUUID(),
      toolCallId: tool.callID,
      output: "Processing was interrupted",
      isError: true,
    });
  }
}

function addStepStart(context: StreamEventContext): void {
  context.messagePartWriter.add({
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "step-start",
  });
}

function addStepFinish(event: StreamEvent, context: StreamEventContext): void {
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
    id: crypto.randomUUID(),
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
