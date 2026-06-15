import { LlmCall, type Message } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { APIError } from "../error";
import { Retry } from "./retry";
import {
  cleanupPendingTools,
  createStreamEventState,
  handleStreamEvent,
} from "./processor-events.js";
import { createNoopSink, createProjectedSink, publishStatus } from "./processor-sink.js";
import {
  defaultStream,
  type ProcessResult,
  type ProcessorInfo,
  type ProcessorOptions as ProcessorOptionsInternal,
  type StreamInput as StreamInputInternal,
} from "./processor-types.js";

export namespace Processor {
  export interface StreamInput extends StreamInputInternal {}
  export interface ProcessorOptions extends ProcessorOptionsInternal {}

  export function create(options: ProcessorOptions): ProcessorInfo {
    const {
      assistantMessage,
      sessionID,
      model,
      abort,
      sink: configuredSink = createNoopSink(),
      onToolCall,
      createStream = defaultStream,
      trace,
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

    return {
      get message() {
        return assistantMessage;
      },

      async process(streamInput: StreamInput): Promise<ProcessResult> {
        publishStatus(sink, sessionID, { type: "busy" });
        const pendingTools: Message.ToolPart[] = [];

        try {
          while (true) {
            try {
              const stream = await createStream(streamInput);
              const eventState = createStreamEventState();

              for await (const event of stream.fullStream) {
                abort.throwIfAborted();
                await handleStreamEvent(event, eventState, {
                  sessionID,
                  assistantMessage,
                  model,
                  sink,
                  pendingTools,
                  messagePartWriter: { add: addMessagePart, update: updateMessagePart },
                  onToolCall,
                });
              }

              assistantMessage.time.completed = Date.now();
              publishStatus(sink, sessionID, { type: "idle" });
              return "stop";
            } catch (e: unknown) {
              const retryReason = Retry.isRetryable(e);

              if (retryReason !== undefined) {
                attempt++;
                const delayMs = Retry.delay(attempt, APIError.isInstance(e) ? e : undefined);
                if (trace) {
                  Bus.publish(LlmCall.RetryDecided, {
                    traceId: trace.traceId,
                    sessionId: trace.sessionId,
                    ...(trace.runId !== undefined && { runId: trace.runId }),
                    attempt,
                    maxAttempts: Number.MAX_SAFE_INTEGER,
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

                try {
                  await Retry.sleep(delayMs, abort);
                } catch (sleepError) {
                  if (sleepError instanceof DOMException && sleepError.name === "AbortError") {
                    cleanupPendingTools(pendingTools, updateMessagePart, sink);
                    publishStatus(sink, sessionID, { type: "idle" });
                    throw sleepError;
                  }
                  throw sleepError;
                }

                continue;
              }

              if (e instanceof DOMException && e.name === "AbortError") {
                cleanupPendingTools(pendingTools, updateMessagePart, sink);
                publishStatus(sink, sessionID, { type: "idle" });
                throw e;
              }

              cleanupPendingTools(pendingTools, updateMessagePart, sink);
              assistantMessage.time.completed = Date.now();
              publishStatus(sink, sessionID, { type: "idle" });
              throw e;
            }
          }
        } catch (e) {
          cleanupPendingTools(pendingTools, updateMessagePart, sink);
          publishStatus(sink, sessionID, { type: "idle" });
          throw e;
        } finally {
          await sink.flush();
        }
      },
    };
  }
}
