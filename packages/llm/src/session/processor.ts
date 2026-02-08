import { z } from "zod";
import type { Sink } from "@openomni/protocol";
import { Message } from "./message";
import { Retry } from "./retry";
import { APIError } from "../error";
import { Provider } from "../provider";

export namespace Processor {
  export type ProcessResult = "stop" | "continue" | "compact";

  export interface ToolResult {
    output: string;
    title: string;
    metadata?: Record<string, unknown>;
  }

  export interface StreamInput {
    messages: unknown[];
    model: Provider.Model;
    system: string;
  }

  interface StreamEvent {
    type: string;
    [key: string]: unknown;
  }

  interface Stream {
    fullStream: AsyncIterable<StreamEvent>;
  }

  export interface ProcessorOptions {
    assistantMessage: Message.AssistantMessage;
    sessionID: string;
    model: Provider.Model;
    abort: AbortSignal;
    sink?: Sink;
    onToolCall?: (part: Message.ToolPart) => Promise<ToolResult>;
    createStream?: (input: StreamInput) => Promise<Stream>;
  }

  export interface ProcessorInfo {
    message: Message.AssistantMessage;
    process(streamInput: StreamInput): Promise<ProcessResult>;
  }

  function generateId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).substring(2, 11)}`;
  }

  function defaultStream(_input: StreamInput): Promise<Stream> {
    return Promise.resolve({
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    });
  }

  export function create(options: ProcessorOptions): ProcessorInfo {
    const {
      assistantMessage,
      sessionID,
      abort,
      sink = createNoopSink(),
      onToolCall,
      createStream = defaultStream,
    } = options;

    let attempt = 0;

    function publishPartUpdate(part: Message.Part, delta?: string): void {
      // Event published via sink.onMessage() - no need for Bus.publish
    }

    const messageParts: Message.Part[] = [];

    function addMessagePart(part: Message.Part): void {
      messageParts.push(part);
      sink.onMessage({ info: assistantMessage, parts: [...messageParts] });
    }

    function updateMessagePart(part: Message.Part): void {
      const partIndex = messageParts.findIndex((item) => item.id === part.id);
      if (partIndex >= 0) {
        messageParts[partIndex] = part;
      } else {
        messageParts.push(part);
      }
      sink.onMessage({ info: assistantMessage, parts: [...messageParts] });
    }

    function publishStatus(state: Record<string, unknown>): void {
      sink.onSnapshot({
        id: generateId("snapshot"),
        sessionID,
        timestamp: Date.now(),
        state,
      });
    }

    return {
      get message() {
        return assistantMessage;
      },

      async process(streamInput: StreamInput): Promise<ProcessResult> {
        publishStatus({ type: "busy" });
        const pendingTools: Message.ToolPart[] = [];

        try {
          while (true) {
            try {
              let currentText: Message.TextPart | undefined;
              const reasoningMap: Record<string, Message.ReasoningPart> = {};

              const stream = await createStream(streamInput);

              for await (const event of stream.fullStream) {
                abort.throwIfAborted();

                switch (event.type) {
                  case "text-start": {
                    const now = Date.now();
                    currentText = {
                      id: generateId("part"),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "text",
                      text: "",
                      time: { start: now },
                      metadata:
                        (event.providerMetadata as Record<string, unknown>) ||
                        {},
                    };
                    addMessagePart(currentText);
                    break;
                  }

                  case "text-delta": {
                    if (currentText) {
                      currentText.text += String(event.text || "");
                      if (event.providerMetadata) {
                        currentText.metadata = event.providerMetadata as Record<
                          string,
                          unknown
                        >;
                      }
                      updateMessagePart(currentText);
                      publishPartUpdate(currentText, String(event.text || ""));
                    }
                    break;
                  }

                  case "text-end": {
                    if (currentText && currentText.time) {
                      currentText.text = currentText.text.trimEnd();
                      currentText.time = {
                        start: currentText.time.start,
                        end: Date.now(),
                      };
                      if (event.providerMetadata) {
                        currentText.metadata = event.providerMetadata as Record<
                          string,
                          unknown
                        >;
                      }
                      updateMessagePart(currentText);
                      publishPartUpdate(currentText);
                    }
                    currentText = undefined;
                    break;
                  }

                  case "reasoning-start": {
                    const reasoningId = String(event.id);
                    if (!(reasoningId in reasoningMap)) {
                      const now = Date.now();
                      const part: Message.ReasoningPart = {
                        id: generateId("part"),
                        sessionID,
                        messageID: assistantMessage.id,
                        type: "reasoning",
                        text: "",
                        time: { start: now, end: undefined },
                        metadata:
                          (event.providerMetadata as Record<string, unknown>) ||
                          {},
                      };
                      reasoningMap[reasoningId] = part;
                      addMessagePart(part);
                    }
                    break;
                  }

                  case "reasoning-delta": {
                    const reasoningId = String(event.id);
                    if (reasoningId in reasoningMap) {
                      const part = reasoningMap[reasoningId];
                      part.text += String(event.text || "");
                      if (event.providerMetadata) {
                        part.metadata = event.providerMetadata as Record<
                          string,
                          unknown
                        >;
                      }
                      updateMessagePart(part);
                      publishPartUpdate(part, String(event.text || ""));
                    }
                    break;
                  }

                  case "reasoning-end": {
                    const reasoningId = String(event.id);
                    if (reasoningId in reasoningMap) {
                      const part = reasoningMap[reasoningId];
                      part.text = part.text.trimEnd();
                      part.time = {
                        start: part.time.start,
                        end: Date.now(),
                      };
                      if (event.providerMetadata) {
                        part.metadata = event.providerMetadata as Record<
                          string,
                          unknown
                        >;
                      }
                      updateMessagePart(part);
                      publishPartUpdate(part);
                      delete reasoningMap[reasoningId];
                    }
                    break;
                  }

                  case "tool-call": {
                    const toolPart: Message.ToolPart = {
                      id: generateId("part"),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "tool",
                      callID: String(event.toolCallId),
                      tool: String(event.toolName),
                      state: {
                        status: "pending",
                        input: (event.args as Record<string, unknown>) || {},
                      },
                    };
                    addMessagePart(toolPart);
                    pendingTools.push(toolPart);
                    publishPartUpdate(toolPart);
                    sink.onToolCall({
                      id: toolPart.callID,
                      tool: toolPart.tool,
                      input: toolPart.state.input,
                    });

                    if (onToolCall) {
                      toolPart.state = {
                        status: "running",
                        input: toolPart.state.input,
                        time: { start: Date.now() },
                      };
                      updateMessagePart(toolPart);
                      publishPartUpdate(toolPart);

                      try {
                        const result = await onToolCall(toolPart);
                        toolPart.state = {
                          status: "completed",
                          input: toolPart.state.input,
                          output: result.output,
                          title: result.title,
                          metadata: result.metadata ?? {},
                          time: {
                            start:
                              (toolPart.state as any).time?.start ?? Date.now(),
                            end: Date.now(),
                          },
                        };
                        updateMessagePart(toolPart);
                        publishPartUpdate(toolPart);
                        sink.onToolResult({
                          id: generateId("tool-result"),
                          toolCallId: toolPart.callID,
                          output: result.output,
                        });
                      } catch (err) {
                        const errorMessage =
                          err instanceof Error ? err.message : String(err);
                        toolPart.state = {
                          status: "error",
                          input: toolPart.state.input,
                          error: errorMessage,
                          time: {
                            start:
                              (toolPart.state as any).time?.start ?? Date.now(),
                            end: Date.now(),
                          },
                        };
                        updateMessagePart(toolPart);
                        publishPartUpdate(toolPart);
                        sink.onToolResult({
                          id: generateId("tool-result"),
                          toolCallId: toolPart.callID,
                          output: errorMessage,
                          isError: true,
                        });
                      }
                      const idx = pendingTools.indexOf(toolPart);
                      if (idx >= 0) pendingTools.splice(idx, 1);
                    }
                    break;
                  }

                  case "step-start": {
                    const stepPart: Message.StepStartPart = {
                      id: generateId("part"),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "step-start",
                    };
                    addMessagePart(stepPart);
                    break;
                  }

                  case "step-finish": {
                    const finishReason = String(
                      event.finishReason || "end_turn",
                    );
                    const usage = event.usage as
                      | {
                          promptTokens?: number;
                          completionTokens?: number;
                        }
                      | undefined;

                    const stepFinishPart: Message.StepFinishPart = {
                      id: generateId("part"),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "step-finish",
                      reason: finishReason,
                      cost: 0,
                      tokens: {
                        input: usage?.promptTokens ?? 0,
                        output: usage?.completionTokens ?? 0,
                      },
                    };
                    addMessagePart(stepFinishPart);

                    assistantMessage.finish = finishReason;
                    if (usage) {
                      assistantMessage.tokens.input += usage.promptTokens ?? 0;
                      assistantMessage.tokens.output +=
                        usage.completionTokens ?? 0;
                    }
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

              assistantMessage.time.completed = Date.now();
              publishStatus({ type: "idle" });
              return "stop";
            } catch (e: unknown) {
              const retryReason = Retry.isRetryable(e);

              if (retryReason !== undefined) {
                attempt++;
                const delayMs = Retry.delay(
                  attempt,
                  APIError.isInstance(e) ? e : undefined,
                );

                publishStatus({
                  type: "retry",
                  attempt,
                  message: String(retryReason),
                  next: Date.now() + delayMs,
                });

                try {
                  await Retry.sleep(delayMs, abort);
                } catch (sleepError) {
                  if (
                    sleepError instanceof DOMException &&
                    sleepError.name === "AbortError"
                  ) {
                    cleanupPendingTools(pendingTools, updateMessagePart, sink);
                    publishStatus({ type: "idle" });
                    throw sleepError;
                  }
                  throw sleepError;
                }

                continue;
              }

              if (e instanceof DOMException && e.name === "AbortError") {
                cleanupPendingTools(pendingTools, updateMessagePart, sink);
                publishStatus({ type: "idle" });
                throw e;
              }

              cleanupPendingTools(pendingTools, updateMessagePart, sink);
              assistantMessage.time.completed = Date.now();
              publishStatus({ type: "idle" });
              return "stop";
            }
          }
        } catch (e) {
          cleanupPendingTools(pendingTools, updateMessagePart, sink);
          publishStatus({ type: "idle" });
          throw e;
        }
      },
    };
  }

  function createNoopSink(): Sink {
    return {
      onMessage: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onSnapshot: () => {},
    };
  }

  function cleanupPendingTools(
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
            start:
              tool.state.status === "running"
                ? tool.state.time.start
                : Date.now(),
            end: Date.now(),
          },
        };
        updateMessagePart(tool);
        sink.onToolResult({
          id: generateId("tool-result"),
          toolCallId: tool.callID,
          output: "Processing was interrupted",
          isError: true,
        });
      }
    }
  }
}
