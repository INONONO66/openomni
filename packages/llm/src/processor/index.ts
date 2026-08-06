import {
  LlmCall,
  Operational,
  type Message,
  type Run,
  type Sink,
  type Tool,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { APIError } from "../error";
import { Retry } from "../retry";
import type { Provider } from "../provider";
import {
  cleanupPendingTools,
  createStreamEventState,
  handleStreamEvent,
  type StreamEvent,
} from "./stream-events.js";

export namespace Processor {
  const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

  interface StreamInput {
    system: string;
  }

  interface Stream {
    fullStream: AsyncIterable<StreamEvent>;
  }

  export interface ProcessorOptions {
    assistantMessage: Message.AssistantMessage;
    sessionID: string;
    model: Provider.Model;
    abort: AbortSignal;
    maxRetryAttempts?: number;
    sink?: Sink;
    createStream: (input: StreamInput) => Promise<Stream>;
    trace?: { traceId: string; sessionId: string; runId?: string; provider?: string };
  }

  interface ProcessorInfo {
    message: Message.AssistantMessage;
    process(streamInput: StreamInput): Promise<void>;
  }

  export function create(options: ProcessorOptions): ProcessorInfo {
    const {
      assistantMessage,
      sessionID,
      model,
      abort,
      sink: configuredSink = createNoopSink(),
      createStream,
      maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
      trace,
    } = options;

    const retryAttemptLimit = Number.isFinite(maxRetryAttempts)
      ? Math.max(0, Math.floor(maxRetryAttempts))
      : DEFAULT_MAX_RETRY_ATTEMPTS;
    const sink = createProjectedSink(configuredSink, sessionID);
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

    return {
      get message() {
        return assistantMessage;
      },

      async process(streamInput: StreamInput): Promise<void> {
        publishStatus(sink, sessionID, { type: "busy" });
        const pendingTools: Message.ToolPart[] = [];
        let attempt = 0;

        try {
          while (true) {
            try {
              const stream = await createStream(streamInput);
              const eventState = createStreamEventState();

              for await (const event of stream.fullStream) {
                abort.throwIfAborted();
                handleStreamEvent(event, eventState, {
                  sessionID,
                  assistantMessage,
                  sink,
                  pendingTools,
                  messagePartWriter: { add: addMessagePart, update: updateMessagePart },
                });
              }

              assistantMessage.time.completed = Date.now();
              return;
            } catch (e: unknown) {
              const retryReason = Retry.isRetryable(e);

              if (retryReason === undefined || ++attempt > retryAttemptLimit) {
                if (!(e instanceof DOMException && e.name === "AbortError")) {
                  assistantMessage.time.completed = Date.now();
                }
                throw e;
              }

              const delayMs = Retry.delay(attempt, APIError.isInstance(e) ? e : undefined);
              if (trace) {
                Bus.publish(LlmCall.RetryDecided, {
                  traceId: trace.traceId,
                  sessionId: trace.sessionId,
                  ...(trace.runId !== undefined && { runId: trace.runId }),
                  attempt,
                  maxAttempts: retryAttemptLimit,
                  reason: retryReason,
                  backoffMs: delayMs,
                  time: Date.now(),
                });

                if (retryReason === "Too Many Requests" || retryReason === "Rate Limited") {
                  Bus.publish(LlmCall.RateLimited, {
                    traceId: trace.traceId,
                    sessionId: trace.sessionId,
                    ...(trace.runId !== undefined && { runId: trace.runId }),
                    provider: trace.provider ?? model.providerID,
                    retryAfterMs: delayMs,
                    time: Date.now(),
                  });
                }
              }

              publishStatus(sink, sessionID, {
                type: "retry",
                attempt,
                message: String(retryReason),
                next: Date.now() + delayMs,
              });

              await Retry.sleep(delayMs, abort);
            }
          }
        } catch (e) {
          cleanupPendingTools(pendingTools, updateMessagePart, sink);
          throw e;
        } finally {
          publishStatus(sink, sessionID, { type: "idle" });
        }
      },
    };
  }

  function createProjectedSink(sink: Sink, sessionID: string): Sink {
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
        publish("sink.message", {
          role: message.info.role,
          messageId: message.info.id,
          partCount: message.parts.length,
        });
      },

      onToolCall(call: Tool.Call) {
        sink.onToolCall(call);
        publish("sink.tool.started", {
          toolCallId: call.id,
          toolName: call.tool,
          inputSummary: summarizeRecord(call.input),
        });
      },

      onToolResult(result: Tool.Result) {
        sink.onToolResult(result);
        publish("sink.tool.completed", {
          toolCallId: result.toolCallId,
          outputLength: result.output.length,
          isError: result.isError,
        });
      },

      onSnapshot(snapshot: Run.Snapshot) {
        sink.onSnapshot(snapshot);
        publish("sink.snapshot", { stateType: String(snapshot.state.type ?? "unknown") });
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

  function publishStatus(sink: Sink, sessionID: string, state: Record<string, unknown>): void {
    sink.onSnapshot({
      id: crypto.randomUUID(),
      sessionID,
      timestamp: Date.now(),
      state,
    });
  }

  function summarizeRecord(input: Record<string, unknown>): string {
    const keys = Object.keys(input).sort();
    return keys.length === 0 ? "empty" : keys.join(",");
  }
}
