import {
  LlmCall,
  Operational,
  Transcript,
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
  createStreamEventState,
  drainToolSettlements,
  handleStreamEvent,
  mapFinishReason,
  settleAttempt,
  type StreamEvent,
  type StreamEventContext,
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

  /**
   * Fold-based stream processor (#545 T2): every observation becomes a
   * Transcript.Fact folded into per-attempt state. Per-token deltas only grow
   * an internal buffer (O(1)); sink.onMessage fires at part boundaries only
   * (part.appended / part.advanced / message.finished) with the immutable
   * fold state — an emitted snapshot is never mutated afterwards. Attempt
   * boundary = state boundary: each retry folds from scratch under a new
   * attemptId, and the failed attempt closes with finish:"error" first.
   */
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

    let folded: Message.WithParts | undefined;

    function record(fact: Transcript.Fact): void {
      const outcome = Transcript.fold(folded, fact);
      if ("rejected" in outcome) {
        // A rejected fact is a recording defect (bad fact order), never a
        // recoverable branch.
        throw new Error(`transcript recording defect: ${outcome.reason} on ${fact.type}`);
      }
      folded = outcome.state;
      sink.onFact?.(fact);
      // Snapshots go out at part boundaries only; the fold state is immutable
      // so consumers may hold it without copying.
      if (fact.type !== "message.created") {
        sink.onMessage(folded);
      }
    }

    function debugNote(msg: string, data?: Record<string, unknown>): void {
      publishInfo(sessionID, trace?.traceId, msg, data);
    }

    return {
      get message() {
        return (folded?.info ?? assistantMessage) as Message.AssistantMessage;
      },

      async process(streamInput: StreamInput): Promise<void> {
        publishStatus(sink, sessionID, { type: "busy" });
        let attempt = 0;
        let attemptSeq = 0;

        try {
          while (true) {
            // No natural attempt id exists at run() callsites, so attempt
            // identity is derived here: messageID (unique per run) + a local
            // attempt counter.
            attemptSeq += 1;
            const attemptId = `${assistantMessage.id}#${attemptSeq}`;
            folded = undefined;
            record({ type: "message.created", attemptId, message: { ...assistantMessage } });

            const eventState = createStreamEventState();
            const eventContext: StreamEventContext = {
              sessionID,
              messageID: assistantMessage.id,
              attemptId,
              sink,
              record,
              note: debugNote,
            };

            function finishAttempt(finish: Transcript.FinishReason): void {
              record({
                type: "message.finished",
                attemptId,
                messageId: assistantMessage.id,
                at: Date.now(),
                finish,
                usage: eventState.usage,
              });
            }

            try {
              const stream = await createStream(streamInput);

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

              // Clean stream end: the AI SDK can stop (stepCountIs) after
              // emitting tool-call events whose results will never arrive —
              // settle them, then close the attempt.
              settleAttempt(eventState, eventContext, { aborted: false });
              finishAttempt(mapFinishReason(eventState.finishReason));
              return;
            } catch (e: unknown) {
              const apiError = coerceApiError(e);
              const decision = Retry.decide(attempt + 1, apiError ?? e);

              if (!decision.retry || ++attempt > retryAttemptLimit) {
                if (!decision.retry && decision.reason !== "non_retryable" && trace) {
                  // A retryable error declined for another reason (e.g. the
                  // server-directed wait exceeded the cap) must say why.
                  Bus.publish(Operational.Error, {
                    traceId: trace.traceId,
                    time: Date.now(),
                    sessionId: trace.sessionId,
                    component: "llm.retry",
                    msg: "retry declined",
                    error:
                      decision.detail === undefined
                        ? decision.reason
                        : `${decision.reason}: ${decision.detail}`,
                  });
                }
                const aborted = e instanceof DOMException && e.name === "AbortError";
                settleAttempt(eventState, eventContext, { aborted });
                finishAttempt(aborted ? "aborted" : "error");
                throw e;
              }
              const retryReason = decision.reason;

              // The failed attempt closes before the next one starts: tool
              // calls from it will never receive a result from the next
              // attempt's stream, and its parts must not re-emit.
              settleAttempt(eventState, eventContext, { aborted: false });
              finishAttempt("error");

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

                if (publishesRateLimited(retryReason)) {
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
                message: retryReason,
                next: Date.now() + delayMs,
              });

              await Retry.sleep(delayMs, abort);
            }
          }
        } finally {
          publishStatus(sink, sessionID, { type: "idle" });
        }
      },
    };
  }

  /**
   * Exhaustive over Retry.RetryableReason — no default, so a new reason
   * member fails to compile here instead of silently skipping the
   * RateLimited publish (the exact hazard the old prose string-match had).
   */
  function publishesRateLimited(reason: Retry.RetryableReason): boolean {
    switch (reason) {
      case "rate_limit":
        return true;
      case "overloaded":
      case "server_error":
        return false;
    }
    return reason satisfies never;
  }

  function publishInfo(
    sessionID: string,
    traceId: string | undefined,
    message: string,
    data?: Record<string, unknown>,
  ): void {
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

  function createProjectedSink(sink: Sink, sessionID: string, traceId?: string): Sink {
    function publish(message: string, data?: Record<string, unknown>): void {
      publishInfo(sessionID, traceId, message, data);
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

      onFact(fact: Transcript.Fact) {
        sink.onFact?.(fact);
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
