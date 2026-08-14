import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { LlmCall, Operational, type Message, type Sink, type Tool } from "@openomni/protocol";
import { collector } from "@openomni/telemetry";
import { Processor } from "../../src/processor";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";

type OperationalInfoPayload = {
  traceId: string;
  time: number;
  sessionId?: string;
  component: string;
  msg: string;
  context?: Record<string, unknown>;
};

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
 * an `Operational.Info` named "sink.snapshot" (the `Sink.onSnapshot` hop was
 * removed — no consumer).
 */
function processorInfo(events: ReturnType<typeof collector>): OperationalInfoPayload[] {
  return events
    .named(Operational.Info.name)
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

      await processor.process({ system: "" });

      const textPart = capture
        .finalParts()
        .find((part): part is Message.TextPart => part.type === "text");
      expect(textPart?.text).toBe("Hello");
      expect(textPart?.time?.start).toBeNumber();
      expect(textPart?.time?.end).toBeNumber();
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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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
          { type: "tool-call", toolCallId: "call-orphan", toolName: "lookup", args: { q: "x" } },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "" });

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
                args: {},
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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(statusStates(events)).toEqual(["busy", "idle"]);
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
          { type: "tool-call", toolCallId: "call-1", toolName: "lookup", args: { q: "x" } },
          { type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: "ok" },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "" });
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
        await processor.process({ system: "" });
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }
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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });

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

      await processor.process({ system: "" });
      retries.push(...events.named(LlmCall.RetryDecided.name).map((event) => event as never));
      rateLimits.push(...events.named(LlmCall.RateLimited.name).map((event) => event as never));

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

      await processor.process({ system: "" });
      rateLimits.push(...events.named(LlmCall.RateLimited.name).map((event) => event as never));

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
            yield { type: "tool-call", toolCallId: "call-1", toolName: "lookup", args: {} };
            if (shouldThrow) throw errorInstance;
          })(),
        }),
      });

      try {
        await processor.process({ system: "" });
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
      const modelWithCatalogCost: Provider.Model = {
        id: "claude-opus-4-5",
        providerID: "anthropic",
        name: "Claude Opus",
        cost: { input: 15.0, output: 75.0, cache: { read: 1.5, write: 18.75 } },
      };

      const processor = createProcessor({
        model: modelWithCatalogCost,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.providerID).toBe("anthropic");
      expect(processor.message.modelID).toBe("claude-3-5-sonnet");
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

    test("returns zero cost when model.cost is absent", async () => {
      const modelNoCost: Provider.Model = {
        id: "gpt-4o",
        providerID: "openai",
        name: "GPT-4o",
      };

      const processor = createProcessor({
        model: modelNoCost,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "stop",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

    test("accumulates tokens across multiple step-finish events", async () => {
      const modelWithCatalogCost: Provider.Model = {
        id: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
        name: "Claude 3.5 Sonnet",
        cost: { input: 3, output: 15 },
      };

      const processor = createProcessor({
        model: modelWithCatalogCost,
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

      await processor.process({ system: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(3000);
      expect(processor.message.tokens.output).toBe(1300);
    });
  });
});
