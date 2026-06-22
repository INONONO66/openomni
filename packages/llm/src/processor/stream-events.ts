import type { Message, Sink } from "@openomni/protocol";
import type { Provider } from "../provider";
import { generateId, type StreamEvent, type ToolResult } from "./contracts.js";
import { addStepFinish, addStepStart } from "./step-accounting.js";
import { cleanupPendingTools, handleToolCall, handleToolResult } from "./tool-projection.js";

type MessagePartWriter = {
  add(part: Message.Part): void;
  update(part: Message.Part): void;
};

type StreamEventContext = {
  readonly sessionID: string;
  readonly assistantMessage: Message.AssistantMessage;
  readonly model: Provider.Model;
  readonly sink: Sink;
  readonly pendingTools: Message.ToolPart[];
  readonly messagePartWriter: MessagePartWriter;
  readonly onToolCall?: (part: Message.ToolPart) => Promise<ToolResult>;
};

type StreamEventState = {
  currentText?: Message.TextPart;
  reasoningMap: Record<string, Message.ReasoningPart>;
  textPartMap: Record<string, string[]>;
  reasoningPartMap: Record<string, string[]>;
};

export function createStreamEventState(): StreamEventState {
  return {
    reasoningMap: {},
    textPartMap: {},
    reasoningPartMap: {},
  };
}

export async function handleStreamEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): Promise<void> {
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
      await handleToolCall(event, context);
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

export { cleanupPendingTools };

function startText(event: StreamEvent, state: StreamEventState, context: StreamEventContext): void {
  const now = Date.now();
  state.currentText = {
    id: generateId(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "text",
    text: "",
    time: { start: now },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  state.textPartMap[state.currentText.id] = [];
  context.messagePartWriter.add(state.currentText);
}

function appendText(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  if (!state.currentText) return;
  const textParts = state.textPartMap[state.currentText.id] ?? [];
  state.textPartMap[state.currentText.id] = textParts;
  textParts.push(String(event.text || ""));
  if (event.providerMetadata) {
    state.currentText.metadata = event.providerMetadata as Record<string, unknown>;
  }
  context.messagePartWriter.update(state.currentText);
}

function finishText(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  if (state.currentText?.time) {
    state.currentText.text = (state.textPartMap[state.currentText.id] ?? []).join("").trimEnd();
    delete state.textPartMap[state.currentText.id];
    state.currentText.time = {
      start: state.currentText.time.start,
      end: Date.now(),
    };
    if (event.providerMetadata) {
      state.currentText.metadata = event.providerMetadata as Record<string, unknown>;
    }
    context.messagePartWriter.update(state.currentText);
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
  const now = Date.now();
  const part: Message.ReasoningPart = {
    id: generateId(),
    sessionID: context.sessionID,
    messageID: context.assistantMessage.id,
    type: "reasoning",
    text: "",
    time: { start: now, end: undefined },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  state.reasoningMap[reasoningId] = part;
  state.reasoningPartMap[part.id] = [];
  context.messagePartWriter.add(part);
}

function appendReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const part = state.reasoningMap[String(event.id)];
  if (part == null) return;
  const reasoningParts = state.reasoningPartMap[part.id] ?? [];
  state.reasoningPartMap[part.id] = reasoningParts;
  reasoningParts.push(String(event.text || ""));
  if (event.providerMetadata) {
    part.metadata = event.providerMetadata as Record<string, unknown>;
  }
  context.messagePartWriter.update(part);
}

function finishReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  const part = state.reasoningMap[reasoningId];
  if (part == null) return;
  part.text = (state.reasoningPartMap[part.id] ?? []).join("").trimEnd();
  delete state.reasoningPartMap[part.id];
  part.time = {
    start: part.time?.start ?? Date.now(),
    end: Date.now(),
  };
  if (event.providerMetadata) {
    part.metadata = event.providerMetadata as Record<string, unknown>;
  }
  context.messagePartWriter.update(part);
  delete state.reasoningMap[reasoningId];
}
