import { afterEach, describe, expect, test } from "bun:test";
import { LlmCall, type Message, type Run, type Sink, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { APIError } from "../../src/error";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "msg-retry-cap",
    sessionID: "session-retry-cap",
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-retry-cap",
    modelID: "claude-3-5-sonnet",
    providerID: "anthropic",
    agent: "test-agent",
    path: { cwd: "/test", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

const model: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

function rateLimitError() {
  return new APIError({
    message: JSON.stringify({
      type: "error",
      error: { type: "too_many_requests" },
    }),
    isRetryable: true,
    responseHeaders: { "retry-after-ms": "1" },
  });
}

describe("Processor retry cap", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("stops retrying after configured retry cap", async () => {
    const retryErrors = [rateLimitError(), rateLimitError(), rateLimitError()];
    let attemptCount = 0;
    const retries: number[] = [];
    const unsubRetry = Bus.subscribe(LlmCall.RetryDecided, (event) => {
      retries.push(event.maxAttempts);
    });

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-retry-cap",
      model,
      abort: AbortSignal.timeout(50),
      maxRetryAttempts: 2,
      trace: {
        traceId: "trace-processor-retry-cap",
        sessionId: "session-retry-cap",
      },
      createStream: async () => ({
        fullStream: (async function* () {
          const error = retryErrors[attemptCount];
          attemptCount++;
          if (error !== undefined) {
            throw error;
          }
          yield { type: "finish" };
        })(),
      }),
    });

    try {
      await processor.process({ messages: [], model, system: "" });
      expect.unreachable("Should have thrown the retry error that exceeded the cap");
    } catch (e) {
      expect(e).toBe(retryErrors[2]);
    } finally {
      unsubRetry();
    }

    expect(attemptCount).toBe(3);
    expect(retries).toHaveLength(2);
    expect(retries).toEqual([2, 2]);
  });

  test("retries once, succeeds, and publishes exact retry and rate-limit telemetry", async () => {
    let attemptCount = 0;
    const retries: Array<Record<string, unknown>> = [];
    const rateLimits: Array<Record<string, unknown>> = [];
    const unsubscribeRetry = Bus.subscribe(LlmCall.RetryDecided, (event) => {
      const { time: _time, ...stable } = event;
      retries.push(stable);
    });
    const unsubscribeRateLimit = Bus.subscribe(LlmCall.RateLimited, (event) => {
      const { time: _time, ...stable } = event;
      rateLimits.push(stable);
    });
    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-retry-cap",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 3,
      trace: {
        traceId: "trace-retry-success",
        sessionId: "session-retry-cap",
        runId: "run-retry-success",
        provider: "anthropic",
      },
      createStream: async () => ({
        fullStream: (async function* () {
          attemptCount++;
          if (attemptCount === 1) throw rateLimitError();
          yield { type: "finish" };
        })(),
      }),
    });

    expect(await processor.process({ messages: [], model, system: "" })).toBe("stop");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    unsubscribeRetry();
    unsubscribeRateLimit();

    expect(attemptCount).toBe(2);
    expect(retries).toEqual([
      {
        traceId: "trace-retry-success",
        sessionId: "session-retry-cap",
        runId: "run-retry-success",
        attempt: 1,
        maxAttempts: 3,
        reason: "Too Many Requests",
        backoffMs: 1,
      },
    ]);
    expect(rateLimits).toEqual([
      {
        traceId: "trace-retry-success",
        sessionId: "session-retry-cap",
        runId: "run-retry-success",
        provider: "anthropic",
        retryAfterMs: 1,
      },
    ]);
  });

  test("throws the original non-retryable error without another attempt", async () => {
    const original = new APIError({
      message: "invalid request",
      statusCode: 400,
      isRetryable: false,
    });
    let attemptCount = 0;
    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-retry-cap",
      model,
      abort: new AbortController().signal,
      createStream: async () => ({
        fullStream: (async function* () {
          yield* [];
          attemptCount++;
          throw original;
        })(),
      }),
    });

    try {
      await processor.process({ messages: [], model, system: "" });
      expect.unreachable("Should have thrown the non-retryable error");
    } catch (error) {
      expect(error).toBe(original);
    }
    expect(attemptCount).toBe(1);
  });

  test("cleans up pending tools and finishes idle when stream processing is aborted", async () => {
    const controller = new AbortController();
    const messages: Message.WithParts[] = [];
    const snapshots: Run.Snapshot[] = [];
    const toolResults: Tool.Result[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    };
    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-retry-cap",
      model,
      abort: controller.signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "call-aborted", toolName: "lookup", input: {} };
          controller.abort();
          yield { type: "finish" };
        })(),
      }),
    });

    try {
      await processor.process({ messages: [], model, system: "" });
      expect.unreachable("Should have thrown AbortError");
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      if (!(error instanceof DOMException)) throw new Error("expected DOMException");
      expect(error.name).toBe("AbortError");
    }

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-aborted",
      output: "Processing was interrupted",
      isError: true,
    });
    const finalMessage = messages.at(-1);
    if (finalMessage === undefined) throw new Error("expected final assistant message");
    expect(finalMessage.parts.find((part) => part.type === "tool")).toMatchObject({
      callID: "call-aborted",
      state: { status: "error", error: "Processing was interrupted" },
    });
    const finalSnapshot = snapshots.at(-1);
    if (finalSnapshot === undefined) throw new Error("expected final run snapshot");
    expect(finalSnapshot.state).toEqual({ type: "idle" });
  });
});
