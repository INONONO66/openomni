import { afterEach, describe, expect, test } from "bun:test";
import { LlmCall, Operational, type Message } from "@openomni/protocol";
import { Bus, collector } from "@openomni/telemetry";
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
    const exhausted: string[] = [];
    const unsubExhausted = Bus.subscribe(Operational.Error, (event) => {
      if (event.msg === "retry attempts exhausted") exhausted.push(String(event.error));
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
      events: Bus,
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
      await processor.process({ system: "" });
      expect.unreachable("Should have thrown the retry error that exceeded the cap");
    } catch (e) {
      expect(e).toBe(retryErrors[2]);
    } finally {
      unsubRetry();
      unsubExhausted();
    }

    expect(attemptCount).toBe(3);
    expect(retries).toHaveLength(2);
    expect(retries).toEqual([2, 2]);
    // Pin (#606 audit): budget exhaustion is a decline too — it must say why.
    expect(exhausted).toEqual(["rate_limit: attempt cap 2 exceeded"]);
  });
});

describe("Processor retry header-delay cap (#532 candidate 3)", () => {
  const events = collector();

  afterEach(() => {
    events.reset();
  });

  test("a server-directed wait above the cap fails fast instead of stalling", async () => {
    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-retry-cap",
      model,
      abort: new AbortController().signal,
      sink: {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      events,
      trace: { traceId: "trace-retry-cap", sessionId: "session-retry-cap" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "t" };
          throw new APIError({
            message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
            isRetryable: true,
            responseHeaders: { "retry-after": "3600" },
          });
        })(),
      }),
    });

    const startedAt = Date.now();
    await expect(processor.process({ system: "" })).rejects.toBeDefined();
    // Under the old policy this would have slept for an hour mid-run.
    expect(Date.now() - startedAt).toBeLessThan(1000);

    // A retryable error declined for a reason other than "non_retryable" has
    // to say why, and say it through the port.
    const declined = events
      .named(Operational.Error.name)
      .map((event) => event as { component?: string; traceId?: string });
    const fromRetry = declined.filter((event) => event.component === "llm.retry");
    expect(fromRetry).toHaveLength(1);
    expect(fromRetry[0]?.traceId).toBe("trace-retry-cap");
  });
});
