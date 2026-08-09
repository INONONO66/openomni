import {
  LlmCall,
  Operational,
  type Message,
  type Run,
  type Sink,
  type Tool,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { coerceApiError } from "../error";
import { Retry } from "../retry";
import type { Provider } from "../provider";
import {
  cleanupPendingTools,
  createStreamEventState,
  drainToolSettlements,
  handleStreamEvent,
  type StreamEvent,
} from "./stream-events.js";

export namespace Processor {
  const DEFAULT_MAX_RETRY_ATTEMPTS = 10;
  const STREAM_CLOSE_GRACE_MS = 250;

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
    const sink = createProjectedSink(configuredSink, sessionID, trace?.traceId);
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

        function settlePendingTools(): void {
          cleanupPendingTools(pendingTools, updateMessagePart, sink);
          pendingTools.length = 0;
        }

        try {
          while (true) {
            try {
              const stream = await createStream(streamInput);
              const eventState = createStreamEventState();
              const eventContext = {
                sessionID,
                assistantMessage,
                sink,
                pendingTools,
                messagePartWriter: { add: addMessagePart, update: updateMessagePart },
              };

              const iterator = stream.fullStream[Symbol.asyncIterator]();
              try {
                while (true) {
                  const next = await iterator.next();
                  if (next.done) break;
                  if (abort.aborted) {
                    // Settle tools the SDK already executed before surfacing
                    // the abort (bounded grace) — see drainToolSettlements.
                    await drainToolSettlements(iterator, next.value, eventState, eventContext);
                    abort.throwIfAborted();
                  }
                  handleStreamEvent(next.value, eventState, eventContext);
                }
              } finally {
                // for-await's IteratorClose equivalent: finalize the stream on
                // every exit path (abort, event-handler throw, retryable
                // stream error). Bounded — a generator suspended on a dead
                // await never settles its return(), and close failures never
                // outrank the in-flight outcome.
                const closing = iterator.return?.();
                if (closing !== undefined) {
                  await Promise.race([
                    Promise.resolve(closing).then(
                      () => undefined,
                      () => undefined,
                    ),
                    new Promise<void>((resolve) => {
                      setTimeout(resolve, STREAM_CLOSE_GRACE_MS);
                    }),
                  ]);
                }
              }

              assistantMessage.time.completed = Date.now();
              return;
            } catch (e: unknown) {
              const apiError = coerceApiError(e);
              const decision = Retry.decide(attempt + 1, apiError ?? e);

              if (!decision.retryable || ++attempt > retryAttemptLimit) {
                if (!decision.retryable && decision.reason !== "non_retryable" && trace) {
                  // A retryable error declined for another reason (e.g. the
                  // server-directed wait exceeded the cap) must say why.
                  Bus.publish(Operational.Error, {
                    traceId: trace.traceId,
                    time: Date.now(),
                    sessionId: trace.sessionId,
                    component: "llm.retry",
                    msg: "retry declined",
                    error: decision.reason,
                  });
                }
                if (!(e instanceof DOMException && e.name === "AbortError")) {
                  assistantMessage.time.completed = Date.now();
                }
                throw e;
              }
              const retryReason = decision.reason;

              // Tool calls from the failed attempt will never receive a
              // result from the next attempt's stream — settle them now.
              settlePendingTools();

              const delayMs = decision.delayMs;
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
        } finally {
          // Also covers clean stream end: the AI SDK can stop (stepCountIs)
          // after emitting tool-call events whose results will never arrive.
          settlePendingTools();
          publishStatus(sink, sessionID, { type: "idle" });
        }
      },
    };
  }

  function createProjectedSink(sink: Sink, sessionID: string, traceId?: string): Sink {
    function publish(message: string, data?: Record<string, unknown>): void {
      if (!sessionID) return;
      Bus.publish(Operational.Info, {
        traceId: traceId ?? sessionID,
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
