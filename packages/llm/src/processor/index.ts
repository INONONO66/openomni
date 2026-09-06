import { drainToolSettlements } from "./tool-events";
import {
  Operational,
  Transcript,
  type BusEvent,
  type Message,
  type Tool,
} from "@openomni/protocol";
import type { Sink } from "../sink";
import type { Provider } from "../provider";
import { estimateUsage as defaultEstimateUsage, type EstimateUsage } from "../token";
import {
  createStreamEventState,
  handleStreamEvent,
  mapFinishReason,
  settleAttempt,
  type StreamEvent,
  type StreamEventContext,
} from "./stream-events.js";

export namespace Processor {
  const STREAM_CLOSE_GRACE_MS = 250;

  interface StreamInput {
    system: string;
    /** Exact serialized prompt, used only for missing provider usage. */
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
    externalTools?: boolean;
    estimateUsage?: EstimateUsage;
    sink?: Sink;
    events: BusEvent.Sink;
    createStream: (input: StreamInput) => Promise<Stream>;
    toolNames?: ReadonlyMap<string, string>;
    trace: { traceId: string; sessionId: string; runId?: string; provider?: string };
  }

  interface ProcessorInfo {
    message: Message.AssistantMessage;
    usageTotals: Transcript.Usage;
    visibleOutput: boolean;
    process(streamInput: StreamInput): Promise<void>;
  }

  /** One provider attempt, one immutable transcript fold. Retry is executor control flow. */
  export function create(options: ProcessorOptions): ProcessorInfo {
    const {
      assistantMessage,
      sessionID,
      abort,
      events,
      createStream,
      toolNames,
      estimateUsage = defaultEstimateUsage,
      trace,
      sink: configuredSink = createNoopSink(),
    } = options;
    const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);
    let folded: Message.WithParts | undefined;
    const eventState = createStreamEventState();
    const attemptId = `${assistantMessage.id}#1`;

    function record(fact: Transcript.Fact): void {
      const outcome = Transcript.fold(folded, fact);
      if ("rejected" in outcome)
        throw new Error(`transcript recording defect: ${outcome.reason} on ${fact.type}`);
      folded = outcome.state;
      if (fact.type !== "message.created") sink.onMessage(folded);
    }

    async function process(streamInput: StreamInput): Promise<void> {
      publishStatus(events, sessionID, trace.traceId, "busy");
      record({ type: "message.created", attemptId, message: { ...assistantMessage } });
      const eventContext: StreamEventContext = {
        sessionID,
        messageID: assistantMessage.id,
        attemptId,
        sink,
        record,
        note: (msg, data) => publishInfo(events, sessionID, trace.traceId, msg, data),
        promptText: streamInput.promptText,
        estimateUsage,
        externalTools: options.externalTools,
        ...(toolNames === undefined ? {} : { toolNames }),
      };
      function finish(finish: Transcript.FinishReason): void {
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
        abort.throwIfAborted();
        const stream = await createStream(streamInput);
        const iterator = stream.fullStream[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            if (abort.aborted) {
              await drainToolSettlements(iterator, next.value, eventState, eventContext);
              abort.throwIfAborted();
            }
            handleStreamEvent(next.value, eventState, eventContext);
          }
        } finally {
          const closing = iterator.return?.();
          if (closing !== undefined) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.resolve(closing).then(
                  () => undefined,
                  (error) => {
                    publishInfo(events, sessionID, trace.traceId, "stream.close.failed", {
                      error: String(error),
                    });
                  },
                ),
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, STREAM_CLOSE_GRACE_MS);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
        }
        settleAttempt(eventState, eventContext, {
          aborted: false,
          preserveTools: options.externalTools,
        });
        finish(mapFinishReason(eventState.finishReason));
      } catch (error) {
        const aborted = abort.aborted || (error instanceof Error && error.name === "AbortError");
        settleAttempt(eventState, eventContext, { aborted });
        finish(aborted ? "aborted" : "error");
        throw error;
      } finally {
        publishStatus(events, sessionID, trace.traceId, "idle");
      }
    }
    return {
      get message() {
        return (folded?.info ?? assistantMessage) as Message.AssistantMessage;
      },
      get usageTotals() {
        return { ...eventState.usage, cache: { ...eventState.usage.cache } };
      },
      get visibleOutput() {
        return eventState.visibleOutput;
      },
      process,
    };
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
    return {
      onMessage(message) {
        sink.onMessage(message);
        publishInfo(events, sessionID, traceId, "sink.message", {
          role: message.info.role,
          messageId: message.info.id,
          partCount: message.parts.length,
        });
      },
      onToolCall(call: Tool.Call) {
        sink.onToolCall(call);
        publishInfo(events, sessionID, traceId, "sink.tool.started", {
          toolCallId: call.id,
          toolName: call.tool,
          inputSummary: summarizeRecord(call.input),
        });
      },
      onToolResult(result: Tool.Result) {
        sink.onToolResult(result);
        publishInfo(events, sessionID, traceId, "sink.tool.completed", {
          toolCallId: result.toolCallId,
          outputLength: result.output.length,
          isError: result.isError,
        });
      },
    };
  }
  function createNoopSink(): Sink {
    return {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };
  }
  function publishStatus(
    events: BusEvent.Sink,
    sessionID: string,
    traceId: string,
    stateType: "busy" | "idle",
  ): void {
    publishInfo(events, sessionID, traceId, "sink.snapshot", { stateType });
  }
  function summarizeRecord(input: Record<string, unknown>): string {
    const keys = Object.keys(input).sort();
    return keys.length === 0 ? "empty" : keys.join(",");
  }
}
