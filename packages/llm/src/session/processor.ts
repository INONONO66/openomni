import { Operational, type Message, type Run, type Sink, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { TokenTracker } from "../token";
import { Retry } from "./retry";
import { APIError } from "../error";
import type { Provider } from "../provider";

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

  function generateId(): string {
    return crypto.randomUUID();
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
      model,
      abort,
      sink: configuredSink = createNoopSink(),
      onToolCall,
      createStream = defaultStream,
    } = options;

    const sink = createProjectedSink(configuredSink, sessionID);

    let attempt = 0;

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
        id: generateId(),
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
              const textPartMap: Record<string, string[]> = {};
              const reasoningPartMap: Record<string, string[]> = {};

              const stream = await createStream(streamInput);

              for await (const event of stream.fullStream) {
                abort.throwIfAborted();

                switch (event.type) {
                  case "text-start": {
                    const now = Date.now();
                    currentText = {
                      id: generateId(),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "text",
                      text: "",
                      time: { start: now },
                      metadata: (event.providerMetadata as Record<string, unknown>) || {},
                    };
                    textPartMap[currentText.id] = [];
                    addMessagePart(currentText);
                    break;
                  }

                  case "text-delta": {
                    if (currentText) {
                      const textParts = textPartMap[currentText.id] ?? [];
                      textPartMap[currentText.id] = textParts;
                      textParts.push(String(event.text || ""));
                      if (event.providerMetadata) {
                        currentText.metadata = event.providerMetadata as Record<string, unknown>;
                      }
                      updateMessagePart(currentText);
                    }
                    break;
                  }

                  case "text-end": {
                    if (currentText?.time) {
                      currentText.text = (textPartMap[currentText.id] ?? []).join("").trimEnd();
                      delete textPartMap[currentText.id];
                      currentText.time = {
                        start: currentText.time.start,
                        end: Date.now(),
                      };
                      if (event.providerMetadata) {
                        currentText.metadata = event.providerMetadata as Record<string, unknown>;
                      }
                      updateMessagePart(currentText);
                    }
                    currentText = undefined;
                    break;
                  }

                  case "reasoning-start": {
                    const reasoningId = String(event.id);
                    if (!(reasoningId in reasoningMap)) {
                      const now = Date.now();
                      const part: Message.ReasoningPart = {
                        id: generateId(),
                        sessionID,
                        messageID: assistantMessage.id,
                        type: "reasoning",
                        text: "",
                        time: { start: now, end: undefined },
                        metadata: (event.providerMetadata as Record<string, unknown>) || {},
                      };
                      reasoningMap[reasoningId] = part;
                      reasoningPartMap[part.id] = [];
                      addMessagePart(part);
                    }
                    break;
                  }

                  case "reasoning-delta": {
                    const reasoningId = String(event.id);
                    const part = reasoningMap[reasoningId];
                    if (part != null) {
                      const reasoningParts = reasoningPartMap[part.id] ?? [];
                      reasoningPartMap[part.id] = reasoningParts;
                      reasoningParts.push(String(event.text || ""));
                      if (event.providerMetadata) {
                        part.metadata = event.providerMetadata as Record<string, unknown>;
                      }
                      updateMessagePart(part);
                    }
                    break;
                  }

                  case "reasoning-end": {
                    const reasoningId = String(event.id);
                    const part = reasoningMap[reasoningId];
                    if (part != null) {
                      part.text = (reasoningPartMap[part.id] ?? []).join("").trimEnd();
                      delete reasoningPartMap[part.id];
                      part.time = {
                        start: part.time?.start ?? Date.now(),
                        end: Date.now(),
                      };
                      if (event.providerMetadata) {
                        part.metadata = event.providerMetadata as Record<string, unknown>;
                      }
                      updateMessagePart(part);
                      delete reasoningMap[reasoningId];
                    }
                    break;
                  }

                  case "tool-call": {
                    const toolPart: Message.ToolPart = {
                      id: generateId(),
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
                              toolPart.state.status === "running"
                                ? toolPart.state.time.start
                                : Date.now(),
                            end: Date.now(),
                          },
                        };
                        updateMessagePart(toolPart);
                        sink.onToolResult({
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
                            start:
                              toolPart.state.status === "running"
                                ? toolPart.state.time.start
                                : Date.now(),
                            end: Date.now(),
                          },
                        };
                        updateMessagePart(toolPart);
                        sink.onToolResult({
                          id: generateId(),
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
                      id: generateId(),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "step-start",
                    };
                    addMessagePart(stepPart);
                    break;
                  }

                  case "step-finish": {
                    const finishReason = String(event.finishReason || "end_turn");
                    const usage = TokenTracker.extractUsage({
                      usage: event.usage as
                        | {
                            inputTokens?: number;
                            outputTokens?: number;
                            promptTokens?: number;
                            completionTokens?: number;
                            inputTokenDetails?: {
                              cacheReadTokens?: number;
                              cacheWriteTokens?: number;
                            };
                            outputTokenDetails?: {
                              reasoningTokens?: number;
                            };
                            reasoningTokens?: number;
                            reasoning_tokens?: number;
                            cache_creation_input_tokens?: number;
                            cache_read_input_tokens?: number;
                            raw?: {
                              completion_tokens_details?: {
                                reasoning_tokens?: number;
                              };
                            };
                          }
                        | undefined,
                      providerMetadata: event.providerMetadata as
                        | {
                            anthropic?: {
                              reasoningTokens?: number;
                              cacheCreationInputTokens?: number;
                              cacheReadInputTokens?: number;
                            };
                            openai?: {
                              reasoningTokens?: number;
                              cachedPromptTokens?: number;
                            };
                          }
                        | undefined,
                    });

                    const tokenCost = TokenTracker.calculateCost(
                      usage,
                      model.cost
                        ? {
                            input: model.cost.input,
                            output: model.cost.output,
                            cacheRead: model.cost.cache?.read,
                            cacheWrite: model.cost.cache?.write,
                          }
                        : undefined,
                    );

                    assistantMessage.finish = finishReason;
                    assistantMessage.cost += tokenCost.totalCost;
                    assistantMessage.tokens.input += usage.inputTokens;
                    assistantMessage.tokens.output += usage.outputTokens;
                    assistantMessage.tokens.reasoning += usage.reasoningTokens ?? 0;
                    assistantMessage.tokens.cache.read += usage.cacheReadTokens ?? 0;
                    assistantMessage.tokens.cache.write += usage.cacheWriteTokens ?? 0;

                    const stepFinishPart: Message.StepFinishPart = {
                      id: generateId(),
                      sessionID,
                      messageID: assistantMessage.id,
                      type: "step-finish",
                      reason: finishReason,
                      cost: tokenCost.totalCost,
                      tokens: {
                        input: usage.inputTokens,
                        output: usage.outputTokens,
                        reasoning: usage.reasoningTokens ?? 0,
                        cache: {
                          read: usage.cacheReadTokens ?? 0,
                          write: usage.cacheWriteTokens ?? 0,
                        },
                      },
                    };
                    addMessagePart(stepFinishPart);
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
                const delayMs = Retry.delay(attempt, APIError.isInstance(e) ? e : undefined);

                publishStatus({
                  type: "retry",
                  attempt,
                  message: String(retryReason),
                  next: Date.now() + delayMs,
                });

                try {
                  await Retry.sleep(delayMs, abort);
                } catch (sleepError) {
                  if (sleepError instanceof DOMException && sleepError.name === "AbortError") {
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
              throw e;
            }
          }
        } catch (e) {
          cleanupPendingTools(pendingTools, updateMessagePart, sink);
          publishStatus({ type: "idle" });
          throw e;
        } finally {
          await sink.flush();
        }
      },
    };
  }

  interface ProjectedSink extends Sink {
    flush(): Promise<void>;
  }

  function createProjectedSink(sink: Sink, sessionID: string): ProjectedSink {
    function publish(message: string, data?: Record<string, unknown>): void {
      if (!sessionID) return;
      Bus.publish(Operational.Info, {
        traceId: sessionID,
        time: Date.now(),
        sessionId: sessionID,
        component: "llm.processor",
        msg: message,
        context: data,
      });
    }

    return {
      onMessage(message) {
        sink.onMessage(message);
        publish("sink.message", { payload: message });
      },

      onToolCall(call: Tool.Call) {
        sink.onToolCall(call);
        publish("sink.tool.started", {
          toolCallId: call.id,
          toolName: call.tool,
          args: call.input,
        });
      },

      onToolResult(result: Tool.Result) {
        sink.onToolResult(result);
        publish("sink.tool.completed", {
          toolCallId: result.toolCallId,
          output: result.output,
          isError: result.isError,
        });
      },

      onSnapshot(snapshot: Run.Snapshot) {
        sink.onSnapshot(snapshot);
        publish("sink.snapshot", { payload: snapshot });
      },

      flush() {
        return Promise.resolve();
      },
    };
  }

  function createNoopSink(): Sink {
    return {
      onMessage: () => void 0,
      onToolCall: () => void 0,
      onToolResult: () => void 0,
      onSnapshot: () => void 0,
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
}
