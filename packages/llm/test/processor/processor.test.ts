import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { LlmCall, Operational, type Message, type Tool } from "@openomni/protocol";
import type { Sink } from "../../src/sink";
import { collector } from "../helpers/observation";
import { Processor } from "../../src/processor";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";
import type { EstimateUsage, UsageEstimate } from "../../src/token";

type OperationalInfoPayload = {
  traceId: string;
  time: number;
  sessionId?: string;
  component: string;
  msg: string;
  context?: Record<string, unknown>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function streamOf(chunks: Array<Record<string, unknown>>) {
  return async () => ({
    fullStream: (async function* () {
      yield* chunks as Array<{ type: string }>;
    })(),
  });
}

type PartsCapture = {
  sink: Sink;
  messages: Message.WithParts[];
  finalParts: () => Message.Part[];
  toolCalls: Tool.Call[];
  toolResults: Tool.Result[];
  /** Text of the first text part, captured at each onMessage callback. */
  textTimeline: Array<string | undefined>;
};

function capturingSink(): PartsCapture {
  const messages: Message.WithParts[] = [];
  const toolCalls: Tool.Call[] = [];
  const toolResults: Tool.Result[] = [];
  const textTimeline: Array<string | undefined> = [];

  return {
    sink: {
      onMessage(message) {
        messages.push(message);
        const textPart = message.parts.find(
          (part): part is Message.TextPart => part.type === "text",
        );
        textTimeline.push(textPart?.text);
      },
      onToolCall(call) {
        toolCalls.push(call);
      },
      onToolResult(result) {
        toolResults.push(result);
      },
    },
    messages,
    finalParts: () => messages.at(-1)?.parts ?? [],
    toolCalls,
    toolResults,
    textTimeline,
  };
}

/**
 * Run-status telemetry (busy/retry/idle) goes to the injected events port as
 * an `Operational.Events.Info` named "sink.snapshot" (the `Sink.onSnapshot` hop was
 * removed — no consumer).
 */
function processorInfo(events: ReturnType<typeof collector>): OperationalInfoPayload[] {
  return events
    .named(Operational.Events.Info.name)
    .map((event) => event as OperationalInfoPayload)
    .filter((data) => data.component === "llm.processor");
}
function statusStates(events: ReturnType<typeof collector>): string[] {
  return processorInfo(events)
    .filter((data) => data.msg === "sink.snapshot")
    .map((data) => String((data.context as Record<string, unknown> | undefined)?.stateType));
}

describe("Processor", () => {
  let mockAssistantMessage: Message.AssistantMessage;
  let mockModel: Provider.Model;
  let abortController: AbortController;
  /** The port under test. Reading here rather than off `Bus` is what makes a
   * re-mint through the global bus fail instead of pass. */
  const events = collector();

  beforeEach(() => {
    abortController = new AbortController();
    mockAssistantMessage = {
      id: "msg-123",
      sessionID: "session-456",
      role: "assistant",
      time: {
        created: Date.now(),
      },
      parentID: "parent-789",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "test-agent",
      path: {
        cwd: "/test",
        root: "/",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    };

    mockModel = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };
  });

  afterEach(() => {
    events.reset();
  });

  function createProcessor(overrides: Partial<Processor.ProcessorOptions> = {}) {
    return Processor.create({
      assistantMessage: mockAssistantMessage,
      sessionID: "session-456",
      model: mockModel,
      abort: abortController.signal,
      events,
      trace: { traceId: "trace-processor-test", sessionId: "session-456" },
      createStream: streamOf([{ type: "finish" }]),
      ...overrides,
    });
  }

  describe("Processor.create(input)", () => {
    test("exposes the assistant message and a process method", () => {
      const processor = createProcessor();

      expect(processor.message).toBe(mockAssistantMessage);
      expect(typeof processor.process).toBe("function");
    });
  });

  describe("Processor.process(streamInput)", () => {
    test("fails loudly when generated part identities collide", async () => {
      const uuid = spyOn(crypto, "randomUUID").mockReturnValue(
        "00000000-0000-4000-8000-000000000000",
      );
      try {
        const processor = createProcessor({
          createStream: streamOf([
            { type: "step-start" },
            { type: "step-start" },
            { type: "finish" },
          ]),
        });

        await expect(processor.process({ system: "", promptText: "" })).rejects.toThrow(
          "transcript recording defect",
        );
      } finally {
        uuid.mockRestore();
      }
    });

    test("projects text events into a completed TextPart", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Hello" },
          { type: "text-end", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const textPart = capture
        .finalParts()
        .find((part): part is Message.TextPart => part.type === "text");
      expect(textPart?.text).toBe("Hello");
      expect(textPart?.time?.start).toBeNumber();
      expect(textPart?.time?.end).toBeNumber();
      expect(processor.message.time.completed).toBeNumber();
    });

    test("ignores fullStream events that do not project into transcript parts", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "tool-input-start", id: "tool-input-1", toolName: "read" },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(capture.finalParts()).toEqual([]);
      expect(processor.message.time.completed).toBeNumber();
    });

    test("delivers the full text at part boundaries instead of per delta", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Hello" },
          { type: "text-delta", text: " " },
          { type: "text-delta", text: "World" },
          { type: "text-end", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      // Boundary snapshots only (#545 T2): open part, completed part with the
      // full text, message.finished. Deltas emit nothing through onMessage.
      expect(capture.textTimeline).toEqual(["", "Hello World", "Hello World"]);
    });

    test("projects reasoning events into a ReasoningPart with timing", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "reasoning-start", id: "r1", providerMetadata: {} },
          { type: "reasoning-delta", id: "r1", text: "Step 1" },
          { type: "reasoning-delta", id: "r1", text: " - " },
          { type: "reasoning-delta", id: "r1", text: "Step 2" },
          { type: "reasoning-end", id: "r1", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const reasoningPart = capture
        .finalParts()
        .find((part): part is Message.ReasoningPart => part.type === "reasoning");
      expect(reasoningPart?.text).toBe("Step 1 - Step 2");
      expect(reasoningPart?.time.start).toBeNumber();
      expect(reasoningPart?.time.end).toBeNumber();
    });

    test("projects step-start and step-finish events as parts", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "step-start" },
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              reasoning_tokens: 4,
              cache_creation_input_tokens: 6,
              cache_read_input_tokens: 2,
            },
            providerMetadata: {},
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const types = capture.finalParts().map((part) => part.type);
      expect(types).toEqual(["step-start", "step-finish"]);
      // Provider finish maps into the transcript vocabulary; the raw provider
      // string survives on the step-finish part.
      expect(processor.message.finish).toBe("stop");
      const stepFinish = capture
        .finalParts()
        .find((part): part is Message.StepFinishPart => part.type === "step-finish");
      expect(stepFinish?.reason).toBe("end_turn");
      expect(processor.message.tokens).toEqual({
        input: 10,
        output: 20,
        reasoning: 4,
        cache: { read: 2, write: 6 },
      });
    });

    /**
     * #933: unusable required provider accounting (absent, wrong-typed, or
     * invalid-numeric) is replaced by the injected local estimate, so a
     * non-empty model step can never fold to a trusted zero. A reported
     * numeric zero stays authoritative.
     */
    describe("unusable provider accounting", () => {
      const SENTINEL: UsageEstimate = { inputTokens: 13, outputTokens: 17 };
      const sentinelEstimator: EstimateUsage = () => SENTINEL;

      /**
       * What a provider can actually put in a usage slot: a count, a
       * stringified count, an explicit null, or a boolean. Concrete on purpose
       * — the malformed values under test are enumerated, not erased.
       */
      type ReportedCount = number | string | null | boolean;
      type ReportedUsage = Partial<
        Record<
          "inputTokens" | "input_tokens" | "outputTokens" | "output_tokens",
          ReportedCount
        >
      >;

      function processStep(usage: ReportedUsage | undefined) {
        return createProcessor({
          estimateUsage: sentinelEstimator,
          createStream: streamOf([
            { type: "step-start" },
            {
              type: "step-finish",
              finishReason: "end_turn",
              ...(usage === undefined ? {} : { usage }),
              providerMetadata: {},
            },
            { type: "finish" },
          ]),
        });
      }

      test("substitutes the estimate when provider usage is absent", async () => {
        const processor = processStep(undefined);

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens).toEqual({
          input: SENTINEL.inputTokens,
          output: SENTINEL.outputTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
        expect(processor.usageTotals).toEqual({
          input: SENTINEL.inputTokens,
          output: SENTINEL.outputTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
      });

      test.each([
        ["string", { inputTokens: "100", outputTokens: "50" }],
        ["null", { inputTokens: null, outputTokens: null }],
        ["boolean", { inputTokens: false, outputTokens: true }],
      ])("substitutes the estimate for wrong-typed (%s) provider usage", async (_name, usage) => {
        const processor = processStep(usage);

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(SENTINEL.inputTokens);
        expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
      });

      test.each([
        ["negative", -1],
        ["NaN", Number.NaN],
        ["infinite", Number.POSITIVE_INFINITY],
        ["fractional", 1.5],
        ["unsafe", Number.MAX_SAFE_INTEGER + 1],
      ])(
        "substitutes the estimate for invalid numeric (%s) provider usage",
        async (_name, value) => {
          const capture = capturingSink();
          const processor = createProcessor({
            sink: capture.sink,
            estimateUsage: sentinelEstimator,
            createStream: streamOf([
              { type: "step-start" },
              {
                type: "step-finish",
                finishReason: "end_turn",
                usage: { inputTokens: value, outputTokens: value },
                providerMetadata: {},
              },
              { type: "finish" },
            ]),
          });

          await processor.process({ system: "", promptText: "prompt" });

          expect(processor.message.tokens.input).toBe(SENTINEL.inputTokens);
          expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
          // The fold completes: invalid accounting no longer aborts the step.
          expect(capture.finalParts().some((part) => part.type === "step-finish")).toBe(true);
        },
      );

      test("keeps a reported zero authoritative instead of estimating", async () => {
        const processor = processStep({
          inputTokens: 0,
          input_tokens: 11,
          outputTokens: 0,
          output_tokens: 10,
        });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens).toEqual({
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
      });

      test("substitutes per required field, keeping the usable one", async () => {
        const processor = processStep({ inputTokens: 7, outputTokens: "nope" });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(7);
        expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
      });

      test("keeps multi-step totals additive across estimated and reported steps", async () => {
        const processor = createProcessor({
          estimateUsage: sentinelEstimator,
          createStream: streamOf([
            { type: "step-finish", finishReason: "tool_use", usage: {} },
            {
              type: "step-finish",
              finishReason: "end_turn",
              usage: { inputTokens: 1000, outputTokens: 500 },
            },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(1000 + SENTINEL.inputTokens);
        expect(processor.message.tokens.output).toBe(500 + SENTINEL.outputTokens);
      });

      test("defaults to the ceil(chars/4) estimator when none is injected", async () => {
        const promptText = "0123456789"; // 10 chars → ceil(10/4) = 3
        const processor = createProcessor({
          createStream: streamOf([
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "01234" }, // 5 chars → ceil(5/4) = 2
            { type: "text-end", providerMetadata: {} },
            { type: "step-finish", finishReason: "end_turn", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText });

        expect(processor.message.tokens.input).toBe(3);
        expect(processor.message.tokens.output).toBe(2);
      });

      test("counts reasoning and tool-call emission in the estimated output", async () => {
        // Default estimator (ceil(chars/4)). The step emits no text: 8 chars of
        // reasoning plus a tool call serialized as name + JSON input
        // ("read" + '{"path":"a"}' = 16 chars). Provider reports nothing usable,
        // so the estimate must be ceil(24/4) = 6 - dropping either contribution
        // yields 2 or 4 and fails here.
        const processor = createProcessor({
          createStream: streamOf([
            { type: "reasoning-start", id: "r1", providerMetadata: {} },
            { type: "reasoning-delta", id: "r1", text: "01234567" },
            { type: "reasoning-end", id: "r1", providerMetadata: {} },
            { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
            { type: "step-finish", finishReason: "tool_use", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "" });

        expect(processor.message.tokens.output).toBe(6);
      });

      test("estimates each step's output from that step's emission only", async () => {
        // Default estimator, so the output estimate reads the step's own
        // emitted assistant text. Step 1 emits 8 chars and reports usable
        // counts; step 2 emits 4 chars and reports nothing usable. Step 2's
        // estimate must cover step 2's 4 chars (ceil(4/4) = 1), not the 12
        // accumulated chars (ceil(12/4) = 3) - the per-step reset is what
        // keeps multi-step totals additive.
        const processor = createProcessor({
          createStream: streamOf([
            { type: "step-start" },
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "01234567" },
            { type: "text-end", providerMetadata: {} },
            {
              type: "step-finish",
              finishReason: "tool_use",
              usage: { inputTokens: 1000, outputTokens: 500 },
            },
            { type: "step-start" },
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "89ab" },
            { type: "text-end", providerMetadata: {} },
            { type: "step-finish", finishReason: "end_turn", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "0123456789" });

        expect(processor.message.tokens.output).toBe(500 + 1);
        // Input for the estimated step is the turn-initial prompt (10 chars -> 3).
        expect(processor.message.tokens.input).toBe(1000 + 3);
      });
    });

    test("trims trailing whitespace from text and reasoning at block end", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Hello   " },
          { type: "text-end", providerMetadata: {} },
          { type: "reasoning-start", id: "r1", providerMetadata: {} },
          { type: "reasoning-delta", id: "r1", text: "thinking   " },
          { type: "reasoning-end", id: "r1", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const parts = capture.finalParts();
      const textPart = parts.find((part): part is Message.TextPart => part.type === "text");
      const reasoningPart = parts.find(
        (part): part is Message.ReasoningPart => part.type === "reasoning",
      );
      expect(textPart?.text).toBe("Hello");
      expect(reasoningPart?.text).toBe("thinking");
    });

    test("handles multiple sequential text blocks as separate parts", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "First" },
          { type: "text-end", providerMetadata: {} },
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Second" },
          { type: "text-end", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const textParts = capture
        .finalParts()
        .filter((part): part is Message.TextPart => part.type === "text");
      expect(textParts.map((part) => part.text)).toEqual(["First", "Second"]);
    });

    test("ignores duplicate reasoning-start events with same id", async () => {
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "reasoning-start", id: "r1", providerMetadata: {} },
          { type: "reasoning-start", id: "r1", providerMetadata: {} },
          { type: "reasoning-delta", id: "r1", text: "test" },
          { type: "reasoning-end", id: "r1", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const reasoningParts = capture
        .finalParts()
        .filter((part): part is Message.ReasoningPart => part.type === "reasoning");
      expect(reasoningParts).toHaveLength(1);
      expect(reasoningParts[0]?.text).toBe("test");
    });

    test("settles unresolved tool calls when the stream ends cleanly", async () => {
      // stepCountIs can stop the stream after tool-call events whose results
      // will never arrive; those parts must not stay pending forever.
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: streamOf([
          { type: "tool-call", toolCallId: "call-orphan", toolName: "lookup", input: { q: "x" } },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const toolPart = capture
        .finalParts()
        .find((part): part is Message.ToolPart => part.type === "tool");
      expect(toolPart?.state.status).toBe("error");
      expect(capture.toolResults).toHaveLength(1);
      expect(capture.toolResults[0]).toMatchObject({
        toolCallId: "call-orphan",
        output: "Processing was interrupted",
        isError: true,
      });
    });

    test("settles the failed attempt's tool calls before retrying", async () => {
      let attemptCount = 0;
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              yield {
                type: "tool-call",
                toolCallId: "call-attempt-1",
                toolName: "lookup",
                input: {},
              };
              throw new APIError({
                message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
                isRetryable: true,
                responseHeaders: { "retry-after-ms": "1" },
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });

      expect(attemptCount).toBe(2);
      // The failed attempt's tool part settles as error inside that attempt's
      // snapshots and never re-emits into the retry attempt (#545 T2).
      const settledToolStates = capture.messages
        .flatMap((message) => message.parts)
        .filter((part): part is Message.ToolPart => part.type === "tool")
        .map((part) => part.state.status);
      expect(settledToolStates).toContain("error");
      expect(capture.finalParts().some((part) => part.type === "tool")).toBe(false);
      expect(capture.toolResults).toHaveLength(1);
      expect(capture.toolResults[0]).toMatchObject({
        toolCallId: "call-attempt-1",
        isError: true,
      });
    });

    test("publishes exactly one busy and one idle status on success", async () => {
      const processor = createProcessor();

      await processor.process({ system: "", promptText: "" });
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(statusStates(events)).toEqual(["busy", "idle"]);
    });

    test("publishes idle before a microtask queued by message.finished", async () => {
      const order: string[] = [];
      const orderedEvents = {
        publish(event: { name: string }, data: unknown) {
          const state = (data as { context?: { stateType?: string } }).context?.stateType;
          if (event.name === Operational.Events.Info.name && state === "idle") {
            order.push("idle");
          }
        },
      };
      const processor = createProcessor({
        events: orderedEvents,
        sink: {
          onMessage(message) {
            if ("completed" in message.info.time && message.info.time.completed !== undefined) {
              order.push("finish");
              queueMicrotask(() => order.push("queued"));
            }
          },
          onToolCall: () => undefined,
          onToolResult: () => undefined,
        },
      });

      await processor.process({ system: "", promptText: "" });

      expect(order).toEqual(["finish", "idle", "queued"]);
    });

    test("starts a zero-delay retry after one microtask hop", async () => {
      jest.useFakeTimers();
      try {
        let attempts = 0;
        let secondAttemptHop = -1;
        const retryError = new APIError({
          message: "retry",
          isRetryable: true,
          responseHeaders: { "retry-after-ms": "0" },
        });
        const processor = createProcessor({
          maxRetryAttempts: 1,
          createStream: () => {
            attempts += 1;
            if (attempts === 1) throw retryError;
            return Promise.resolve({
              fullStream: (async function* () {
                yield { type: "finish" };
              })(),
            });
          },
        });

        const processing = processor.process({ system: "", promptText: "" });
        await Promise.resolve();
        expect(attempts).toBe(1);
        let hop = 0;
        let ladder = Promise.resolve();
        for (let i = 0; i < 4; i += 1) {
          ladder = ladder.then(() => {
            hop += 1;
            if (attempts === 2 && secondAttemptHop === -1) secondAttemptHop = hop;
          });
        }
        jest.runAllTimers();
        await ladder;
        await processing;
        // The first createStream continuation and the timer continuation are
        // included in this ladder; the retry itself adds exactly one hop.
        expect(secondAttemptHop).toBe(3);
      } finally {
        jest.useRealTimers();
      }
    });

    test("projects sink callbacks onto the events port", async () => {
      const sinkEvents: string[] = [];
      const toolCalls: Tool.Call[] = [];
      const toolResults: Tool.Result[] = [];
      const messages: Message.WithParts[] = [];

      const sink: Sink = {
        onMessage(message) {
          sinkEvents.push("message");
          messages.push(message);
        },
        onToolCall(call) {
          sinkEvents.push("toolCall");
          toolCalls.push(call);
        },
        onToolResult(result) {
          sinkEvents.push("toolResult");
          toolResults.push(result);
        },
      };

      const processor = createProcessor({
        sink,
        trace: { traceId: "trace-projection", sessionId: "session-456" },
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Hello" },
          { type: "text-end", providerMetadata: {} },
          { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { q: "x" } },
          { type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: "ok" },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(sinkEvents).toContain("message");
      expect(sinkEvents).toContain("toolCall");
      expect(sinkEvents).toContain("toolResult");
      expect(messages.length).toBeGreaterThan(0);
      expect(toolCalls).toEqual([{ id: "call-1", tool: "lookup", input: { q: "x" } }]);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.toolCallId).toBe("call-1");

      const infoEvents = processorInfo(events);
      expect(infoEvents.every((event) => event.component === "llm.processor")).toBe(true);
      expect(infoEvents.every((event) => event.sessionId === "session-456")).toBe(true);
      // sink.* diagnostics must join to llm.call.* events via the run traceId.
      expect(infoEvents.every((event) => event.traceId === "trace-projection")).toBe(true);
      expect(infoEvents.every((event) => typeof event.time === "number")).toBe(true);

      const messageEvents = infoEvents.filter((event) => event.msg === "sink.message");
      const snapshotEvents = infoEvents.filter((event) => event.msg === "sink.snapshot");
      const toolStarted = infoEvents.find((event) => event.msg === "sink.tool.started");
      const toolCompleted = infoEvents.find((event) => event.msg === "sink.tool.completed");

      expect(messageEvents.length).toBe(messages.length);
      expect(snapshotEvents.length).toBe(2);
      expect(toolStarted?.context).toMatchObject({
        toolCallId: "call-1",
        toolName: "lookup",
        inputSummary: "q",
      });
      expect(toolCompleted?.context).toMatchObject({
        toolCallId: "call-1",
        outputLength: 2,
      });
    });

    test("respects abort signal during stream processing", async () => {
      const processor = createProcessor();

      abortController.abort();

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }
    });

    test("classifies a custom-reason abort as aborted, not error", async () => {
      // Regression (#audit H1): production callers abort with
      // controller.abort(new Error("cancelled by coordinator")), so
      // throwIfAborted() throws a plain Error — not a DOMException named
      // AbortError. Classifying by error shape alone closed the attempt as
      // finish:"error" (which toModelMessages hides from replay) and marked
      // in-flight tools as failed instead of interrupted.
      const capture = capturingSink();
      const facts: Array<{ type: string; transition?: { to: string }; finish?: string }> = [];
      const sink: Sink = {
        ...capture.sink,
        onFact: (fact) => facts.push(fact as never),
      };
      const reason = new Error("cancelled by coordinator");
      const processor = createProcessor({
        sink,
        createStream: async () => ({
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "call-abort",
              toolName: "lookup",
              input: {},
            };
            abortController.abort(reason);
            yield { type: "text-start", providerMetadata: {} };
          })(),
        }),
      });

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown the abort reason");
      } catch (e) {
        expect(e).toBe(reason);
      }

      // finish:"aborted", not "error" — toModelMessages hides error-finished
      // turns from replay.
      expect(processor.message.finish).toBe("aborted");
      // The pending tool settles as interrupted (the fold projects it onto
      // Tool.StateError with error:"interrupted" — Tool.State has no
      // interrupted status), not as a plain processing error.
      expect(
        facts.some(
          (fact) => fact.type === "part.advanced" && fact.transition?.to === "interrupted",
        ),
      ).toBe(true);
      const toolPart = capture
        .finalParts()
        .find((part): part is Message.ToolPart => part.type === "tool");
      expect(toolPart?.state.status).toBe("error");
      if (toolPart?.state.status === "error") {
        expect(toolPart.state.error).toBe("interrupted");
      }
    });

    test("warns when an inferred ratelimit reset above the cap demotes to backoff", async () => {
      // #audit: Decision.retryAfterOverCap was produced and unit-tested but
      // consumed by nobody — the demotion now surfaces as Operational.Events.Warn.
      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            yield* [];
            throw new APIError({
              message: "slow down",
              isRetryable: true,
              statusCode: 429,
              responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
            });
          })(),
        }),
      });

      const warnPublished = deferred();
      const originalPublish = events.publish;
      events.publish = (event, data) => {
        originalPublish(event, data);
        if (
          event.name === Operational.Events.Warn.name &&
          (data as OperationalInfoPayload).component === "llm.retry"
        ) {
          warnPublished.resolve();
        }
      };

      const settled = processor.process({ system: "", promptText: "" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      // The warn publishes before the backoff sleep; abort on that exact event.
      await warnPublished.promise;
      abortController.abort();
      await settled;
      events.publish = originalPublish;

      const warns = () =>
        events
          .named(Operational.Events.Warn.name)
          .map((event) => event as OperationalInfoPayload)
          .filter((data) => data.component === "llm.retry");
      expect(warns()).toHaveLength(1);
      expect(warns()[0]).toMatchObject({
        component: "llm.retry",
        msg: "ratelimit reset above cap; demoted to backoff",
      });
      expect((warns()[0]?.context as { backoffMs?: number })?.backoffMs).toBeGreaterThan(0);
    });

    test("retries raw AI SDK provider errors (AI_APICallError shape)", async () => {
      // Regression: production errors come from the AI SDK, whose name is
      // AI_APICallError and whose retry fields live on the error object, not
      // under .data. Without coercion, no real provider error ever retried.
      let attemptCount = 0;
      const sdkError = Object.assign(new Error("Overloaded"), {
        name: "AI_APICallError",
        isRetryable: true,
        statusCode: 529,
        responseHeaders: { "Retry-After-Ms": "1" },
      });

      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw sdkError;
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });

      expect(attemptCount).toBe(2);
    });

    test("published part snapshots are frozen at publish time", async () => {
      // Regression: parts are copy-on-write; a consumer that stores an early
      // snapshot must not observe later mutations through shared references.
      const snapshots: Message.WithParts[] = [];
      const sink: Sink = {
        onMessage: (message) => snapshots.push(message),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      };

      const processor = createProcessor({
        sink,
        createStream: streamOf([
          { type: "text-start", providerMetadata: {} },
          { type: "text-delta", text: "Hello" },
          { type: "text-delta", text: " World" },
          { type: "text-end", providerMetadata: {} },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      const textAt = (index: number) =>
        snapshots[index]?.parts.find((part): part is Message.TextPart => part.type === "text")
          ?.text;
      // Boundary snapshots: the open part stays empty in the first snapshot
      // even after the part later completed with the full text.
      expect(textAt(0)).toBe("");
      expect(textAt(1)).toBe("Hello World");
    });

    test("handles retryable errors with retry logic", async () => {
      let attemptCount = 0;

      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: { type: "too_many_requests" },
                }),
                isRetryable: true,
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });

      expect(attemptCount).toBe(2);
    });

    test("publishes structured retry and rate-limit events", async () => {
      let attemptCount = 0;
      const retries: Array<{ runId?: string; reason: string; backoffMs: number }> = [];
      const rateLimits: Array<{ runId?: string; provider: string; retryAfterMs: number }> = [];

      const processor = createProcessor({
        trace: {
          traceId: "trace-processor-retry",
          sessionId: "session-456",
          runId: "run-processor-retry",
          provider: "anthropic",
        },
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: { type: "too_many_requests" },
                }),
                isRetryable: true,
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });
      retries.push(
        ...events.named(LlmCall.Events.RetryDecided.name).map((event) => event as never),
      );
      rateLimits.push(
        ...events.named(LlmCall.Events.RateLimited.name).map((event) => event as never),
      );

      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({
        runId: "run-processor-retry",
        // The wire value is the typed Retry.Reason literal — a subset of the
        // protocol's z.string(), so no schema change.
        reason: "rate_limit",
      });
      expect(retries[0]?.backoffMs).toBeGreaterThan(0);
      expect(rateLimits).toHaveLength(1);
      expect(rateLimits[0]).toMatchObject({
        runId: "run-processor-retry",
        provider: "anthropic",
        retryAfterMs: retries[0]?.backoffMs,
      });
    });

    test("publishes RateLimited for a real Anthropic 429 rate_limit_error body", async () => {
      // Pin (#532-3): Anthropic sends {type:"error",error:{type:"rate_limit_error"}}
      // with status 429. Under prose classification the generic body.error
      // sniff outranked the 429 status ("Provider Server Error"), so the
      // string-matched RateLimited publish silently skipped a genuine rate
      // limit. The typed reason switch must catch it.
      let attemptCount = 0;
      const rateLimits: Array<{ provider: string; retryAfterMs: number }> = [];

      const processor = createProcessor({
        trace: {
          traceId: "trace-processor-429",
          sessionId: "session-456",
          provider: "anthropic",
        },
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: {
                    type: "rate_limit_error",
                    message: "Number of request tokens has exceeded your per-minute rate limit",
                  },
                }),
                statusCode: 429,
                isRetryable: true,
                responseHeaders: { "retry-after-ms": "1" },
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });
      rateLimits.push(
        ...events.named(LlmCall.Events.RateLimited.name).map((event) => event as never),
      );

      expect(attemptCount).toBe(2);
      expect(rateLimits).toHaveLength(1);
      expect(rateLimits[0]).toMatchObject({ provider: "anthropic", retryAfterMs: 1 });
    });

    test("throws original error instance for non-retryable errors and settles cleanly", async () => {
      const capture = capturingSink();

      const errorInstance = new APIError({
        message: "Specific error",
        statusCode: 500,
        isRetryable: false,
      });

      const processor = createProcessor({
        sink: capture.sink,
        createStream: async () => ({
          fullStream: (async function* (shouldThrow = true) {
            yield { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} };
            if (shouldThrow) throw errorInstance;
          })(),
        }),
      });

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBe(errorInstance);
      }

      // Exactly one idle transition, and the pending tool is closed out once.
      await new Promise((resolve) => queueMicrotask(resolve));
      expect(statusStates(events)).toEqual(["busy", "idle"]);
      expect(capture.toolResults).toHaveLength(1);
      expect(capture.toolResults[0]).toMatchObject({
        toolCallId: "call-1",
        output: "Processing was interrupted",
        isError: true,
      });
      const toolPart = capture
        .finalParts()
        .find((part): part is Message.ToolPart => part.type === "tool");
      expect(toolPart?.state.status).toBe("error");
    });
  });

  describe("token accounting", () => {
    test("keeps local cost at zero and accumulates AI SDK token usage", async () => {
      const model: Provider.Model = {
        id: "claude-opus-4-5",
        providerID: "anthropic",
        name: "Claude Opus",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.providerID).toBe("anthropic");
      expect(processor.message.modelID).toBe("claude-3-5-sonnet");
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

    test("keeps cost at zero for non-anthropic models too", async () => {
      const model: Provider.Model = {
        id: "gpt-4o",
        providerID: "openai",
        name: "GPT-4o",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "stop",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

    test("usageTotals accumulates billed usage across retried attempts", async () => {
      // Regression (#audit M3): LlmCall.Events.Completed read message.tokens — the
      // final attempt's fold — so a retried attempt's billed tokens vanished
      // from telemetry. usageTotals must carry every attempt.
      let attemptCount = 0;
      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              yield {
                type: "step-finish",
                finishReason: "stop",
                usage: { inputTokens: 100, outputTokens: 40 },
                providerMetadata: {},
              };
              throw new APIError({
                message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
                isRetryable: true,
                responseHeaders: { "retry-after-ms": "1" },
              });
            }
            yield {
              type: "step-finish",
              finishReason: "end_turn",
              usage: { inputTokens: 200, outputTokens: 60 },
              providerMetadata: {},
            };
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ system: "", promptText: "" });

      expect(attemptCount).toBe(2);
      // message.tokens reflects only the final attempt's fold...
      expect(processor.message.tokens.input).toBe(200);
      expect(processor.message.tokens.output).toBe(60);
      // ...while the billed total includes the retried attempt.
      expect(processor.usageTotals).toEqual({
        input: 300,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      });
    });

    test("accumulates tokens across multiple step-finish events", async () => {
      const model: Provider.Model = {
        id: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
        name: "Claude 3.5 Sonnet",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "tool_use",
            usage: { inputTokens: 1000, outputTokens: 500 },
          },
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 2000, outputTokens: 800 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(3000);
      expect(processor.message.tokens.output).toBe(1300);
    });
  });
});
