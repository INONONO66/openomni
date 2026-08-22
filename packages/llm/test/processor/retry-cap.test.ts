import { afterEach, describe, expect, test } from "bun:test";
import { LlmCall, Operational, type Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { APIError } from "../../src/error";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";
import { Retry } from "../../src/retry";

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
    const unsubRetry = Bus.subscribe(LlmCall.Events.RetryDecided, (event) => {
      retries.push(event.maxAttempts);
    });
    const exhausted: string[] = [];
    const unsubExhausted = Bus.subscribe(Operational.Events.Error, (event) => {
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
  afterEach(() => {
    Bus.reset();
  });

  test("a server-directed wait above the cap emits the typed decline decision", async () => {
    const cap = 60_000;
    const retryAfterMs = 3_600_000;
    const reason = "rate_limit" satisfies Retry.RetryableReason;
    expect(Retry.RETRY_HEADER_DELAY_CAP).toBe(cap);

    const decisions: Array<{
      traceId: string;
      time: number;
      sessionId?: string;
      component: string;
      msg: string;
      error?: string;
    }> = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Error, (event) => {
      if (event.component === "llm.retry") decisions.push(event);
    });
    const serverError = new APIError({
      message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
      isRetryable: true,
      responseHeaders: { "retry-after": String(retryAfterMs / 1000) },
    });

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
      events: Bus,
      trace: { traceId: "trace-retry-cap", sessionId: "session-retry-cap" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "t" };
          throw serverError;
        })(),
      }),
    });

    try {
      await expect(processor.process({ system: "" })).rejects.toBe(serverError);
    } finally {
      unsubscribe();
    }

    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    if (decision === undefined) expect.unreachable("Expected one retry decline decision");
    expect(decision.time).toBeNumber();
    expect(decision).toEqual({
      traceId: "trace-retry-cap",
      time: decision.time,
      sessionId: "session-retry-cap",
      component: "llm.retry",
      msg: "retry declined",
      error: `${reason}: server asked to wait ${retryAfterMs}ms, above the ${cap}ms cap`,
    });
  });
});
