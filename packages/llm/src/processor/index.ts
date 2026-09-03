import {
  LlmCall,
  Operational,
  Transcript,
  type BusEvent,
  type Message,
  type Tool,
} from "@openomni/protocol";
import type { Sink } from "../sink";
import { coerceApiError } from "../error";
import { Retry } from "../retry";
import type { Provider } from "../provider";
import { estimateUsage as defaultEstimateUsage, type EstimateUsage } from "../token";
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
    /**
     * The prompt text this call sends to the provider, serialized. The caller
     * owns it (only the caller holds the messages and tool specs), and the
     * step-finish fold reads it as the local estimator's input-token source
     * when the provider's own input count is unusable (#933).
     */
    promptText: string;
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
    /**
     * Local usage estimator (#933). Substituted field-wise for unusable
     * required provider counts at step finish. Absent keeps the package
     * default (`ceil(chars / 4)`).
     */
    estimateUsage?: EstimateUsage;
    sink?: Sink;
    /**
     * Where observation goes. A port, not `Bus`, so that what sits behind it
     * is the caller's choice: tests bind a collector, and P2 can split a
     * fail-closed ledger append from the lossy bus without touching this file.
     * The agent passes its own injected port through (turn.ts) — no telemetry
     * import exists anywhere in agent src.
     */
    events: BusEvent.Sink;
    createStream: (input: StreamInput) => Promise<Stream>;
    /**
     * Wire tool name → internal dotted name. The provider echoes the sanitized
     * wire name (`message_send`) on tool-call/result stream events, so the
     * transcript would otherwise record the drifted name; this reverse map
     * restores the dotted internal name (`message.send`) on the recorded part.
     * Absent = record the name verbatim.
     */
    toolNames?: ReadonlyMap<string, string>;
    /**
     * The call's identity. Required: `run()` always has it, and making it
     * optional is what justified filing records under `traceId ?? sessionID`
     * — a session id in the field every reader treats as a trace.
     */
    trace: { traceId: string; sessionId: string; runId?: string; provider?: string };
  }

  interface ProcessorInfo {
    message: Message.AssistantMessage;
    /**
     * Usage summed across every attempt, retries included — the billed
     * total. `message.tokens` reflects only the final attempt's fold, so
     * telemetry that reads it drops the usage retried attempts consumed.
     */
    usageTotals: Transcript.Usage;
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
      events,
      createStream,
      toolNames,
      maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
      estimateUsage = defaultEstimateUsage,
      trace,
    } = options;

    const retryAttemptLimit = Number.isFinite(maxRetryAttempts)
      ? Math.max(0, Math.floor(maxRetryAttempts))
      : DEFAULT_MAX_RETRY_ATTEMPTS;
    const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);

    let folded: Message.WithParts | undefined;
    let terminalFailureStatusPublished = false;

    // Billed usage across attempts. Each attempt folds from scratch, so the
    // final fold's tokens omit what retried attempts consumed; this counter
    // survives the attempt boundary.
    const usageTotals: Transcript.Usage = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };

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
      publishInfo(events, sessionID, trace.traceId, msg, data);
    }

    function handleAttemptFailure(
      error: unknown,
      eventState: ReturnType<typeof createStreamEventState>,
      eventContext: StreamEventContext,
      attemptStartedAt: number,
      attempt: number,
      instantFailureStreak: number,
      finishAttempt: (finish: Transcript.FinishReason) => void,
    ): { attempt: number; instantFailureStreak: number; delayMs: number } {
      const apiError = coerceApiError(error);
      const nextInstantFailureStreak = Retry.isInstantTransportFailure(
        apiError ?? error,
        Date.now() - attemptStartedAt,
      )
        ? instantFailureStreak + 1
        : 0;
      const decision = Retry.decide(attempt + 1, apiError ?? error, nextInstantFailureStreak);
      const nextAttempt = attempt + 1;

      if (!decision.retry || nextAttempt > retryAttemptLimit) {
        publishRetryDecline(decision, retryAttemptLimit, events, trace);
        // Abort classification reads the signal, not the error shape: a
        // custom abort reason may be a plain Error.
        const aborted =
          abort.aborted || (error instanceof DOMException && error.name === "AbortError");
        settleAttempt(eventState, eventContext, { aborted });
        finishAttempt(aborted ? "aborted" : "error");
        terminalFailureStatusPublished = true;
        publishStatus(events, sessionID, trace.traceId, "idle");
        throw error;
      }

      publishRetryOverCapWarning(decision, events, trace);
      // The failed attempt closes before the next one starts: its tools can
      // never receive results from the next stream.
      settleAttempt(eventState, eventContext, { aborted: false });
      finishAttempt("error");
      publishRetryDecision(decision, nextAttempt, retryAttemptLimit, events, trace, model);
      publishStatus(events, sessionID, trace.traceId, "retry");

      return {
        attempt: nextAttempt,
        instantFailureStreak: nextInstantFailureStreak,
        delayMs: decision.delayMs,
      };
    }

    async function runAttempts(streamInput: StreamInput): Promise<void> {
      publishStatus(events, sessionID, trace.traceId, "busy");
      let attempt = 0;
      let attemptSeq = 0;
      // Consecutive instant transport failures (no HTTP status, dead under
      // the window). Reset by any attempt that reaches the endpoint or
      // fails slowly — only an unbroken streak declines the retry.
      let instantFailureStreak = 0;

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
            promptText: streamInput.promptText,
            estimateUsage,
            ...(toolNames !== undefined && { toolNames }),
          };

          function finishAttempt(finish: Transcript.FinishReason): void {
            usageTotals.input += eventState.usage.input;
            usageTotals.output += eventState.usage.output;
            usageTotals.reasoning += eventState.usage.reasoning;
            usageTotals.cache.read += eventState.usage.cache.read;
            usageTotals.cache.write += eventState.usage.cache.write;
            record({
              type: "message.finished",
              attemptId,
              messageId: assistantMessage.id,
              at: Date.now(),
              finish,
              usage: eventState.usage,
            });
          }

          const attemptStartedAt = Date.now();
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
            const retryState = handleAttemptFailure(
              e,
              eventState,
              eventContext,
              attemptStartedAt,
              attempt,
              instantFailureStreak,
              finishAttempt,
            );
            attempt = retryState.attempt;
            instantFailureStreak = retryState.instantFailureStreak;
            await Retry.sleep(retryState.delayMs, abort);
          }
        }
      } finally {
        if (!terminalFailureStatusPublished) {
          publishStatus(events, sessionID, trace.traceId, "idle");
        }
      }
    }

    return {
      get message() {
        return (folded?.info ?? assistantMessage) as Message.AssistantMessage;
      },

      get usageTotals(): Transcript.Usage {
        return { ...usageTotals, cache: { ...usageTotals.cache } };
      },

      process(streamInput: StreamInput): Promise<void> {
        terminalFailureStatusPublished = false;
        return runAttempts(streamInput);
      },
    };
  }

  function publishRetryDecline(
    decision: Retry.Decision,
    retryAttemptLimit: number,
    events: BusEvent.Sink,
    trace: ProcessorOptions["trace"],
  ): void {
    if (!decision.retry && decision.reason === "non_retryable") return;
    const exhausted = decision.retry;
    events.publish(Operational.Events.Error, {
      traceId: trace.traceId,
      time: Date.now(),
      sessionId: trace.sessionId,
      component: "llm.retry",
      msg: exhausted ? "retry attempts exhausted" : "retry declined",
      error: exhausted
        ? `${decision.reason}: attempt cap ${retryAttemptLimit} exceeded`
        : decision.detail === undefined
          ? decision.reason
          : `${decision.reason}: ${decision.detail}`,
    });
  }

  function publishRetryOverCapWarning(
    decision: Extract<Retry.Decision, { retry: true }>,
    events: BusEvent.Sink,
    trace: ProcessorOptions["trace"],
  ): void {
    if (decision.retryAfterOverCap !== true) return;
    events.publish(Operational.Events.Warn, {
      traceId: trace.traceId,
      time: Date.now(),
      sessionId: trace.sessionId,
      component: "llm.retry",
      msg: "ratelimit reset above cap; demoted to backoff",
      context: { backoffMs: decision.delayMs },
    });
  }

  function publishRetryDecision(
    decision: Extract<Retry.Decision, { retry: true }>,
    attempt: number,
    retryAttemptLimit: number,
    events: BusEvent.Sink,
    trace: ProcessorOptions["trace"],
    model: Provider.Model,
  ): void {
    events.publish(LlmCall.Events.RetryDecided, {
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      ...(trace.runId !== undefined && { runId: trace.runId }),
      attempt,
      maxAttempts: retryAttemptLimit,
      reason: decision.reason,
      backoffMs: decision.delayMs,
      time: Date.now(),
    });
    if (!publishesRateLimited(decision.reason)) return;
    events.publish(LlmCall.Events.RateLimited, {
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      ...(trace.runId !== undefined && { runId: trace.runId }),
      provider: trace.provider ?? model.providerID,
      retryAfterMs: decision.delayMs,
      time: Date.now(),
    });
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
    events: BusEvent.Sink,
    sessionID: string,
    traceId: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    events.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      sessionId: sessionID,
      component: "llm.processor",
      msg: message,
      context: data,
    });
  }

  function createProjectedSink(
    events: BusEvent.Sink,
    sink: Sink,
    sessionID: string,
    traceId: string,
  ): Sink {
    function publish(message: string, data?: Record<string, unknown>): void {
      publishInfo(events, sessionID, traceId, message, data);
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
    };
  }

  function createNoopSink(): Sink {
    return {
      onMessage: () => void 0,
      onToolCall: () => void 0,
      onToolResult: () => void 0,
    };
  }

  /**
   * Run-status telemetry (busy / retry / idle). This used to ride
   * Sink.onSnapshot, but every production consumer was a no-op, so the sink
   * hop was removed; the operational publish — the only observable effect it
   * ever had — stays, under the same msg name for log continuity.
   */
  function publishStatus(
    events: BusEvent.Sink,
    sessionID: string,
    traceId: string,
    stateType: string,
  ): void {
    publishInfo(events, sessionID, traceId, "sink.snapshot", { stateType });
  }

  function summarizeRecord(input: Record<string, unknown>): string {
    const keys = Object.keys(input).sort();
    return keys.length === 0 ? "empty" : keys.join(",");
  }
}
