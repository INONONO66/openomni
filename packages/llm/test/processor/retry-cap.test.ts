import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  anthropicModel as model,
  assistantMessage as buildAssistantMessage,
} from "../helpers/fixtures";
import { LlmCall, Operational } from "@openomni/protocol";
import { Bus, collector } from "@openomni/telemetry";
import { APIError } from "../../src/error";
import { Processor } from "../../src/processor";
import { Retry } from "../../src/retry";

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
      assistantMessage: buildAssistantMessage(
        "msg-retry-cap",
        "session-retry-cap",
        "parent-retry-cap",
      ),
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
      assistantMessage: buildAssistantMessage(
        "msg-retry-cap",
        "session-retry-cap",
        "parent-retry-cap",
      ),
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

function transportError() {
  // Connection refused: retryable per the SDK, but no HTTP response — no
  // status code, no headers. Dies the moment the stream is consumed.
  return new APIError({ message: "fetch failed", isRetryable: true });
}

describe("Processor instant transport-failure streak", () => {
  const events = collector();

  afterEach(() => {
    events.reset();
  });

  test("three instant connection failures end the run instead of burning the backoff budget", async () => {
    let attemptCount = 0;
    // Delay selection is observable through both the retry event and this
    // scheduler boundary. Resolve it synchronously so the test pins the exact
    // probe ladder without spending 500ms on real timers.
    const sleep = spyOn(Retry, "sleep").mockResolvedValue(undefined);
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage(
        "msg-instant-streak",
        "session-instant-streak",
        "parent-instant-streak",
      ),
      sessionID: "session-instant-streak",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 10,
      trace: { traceId: "trace-instant-streak", sessionId: "session-instant-streak" },
      events,
      createStream: async () => ({
        fullStream: (async function* () {
          attemptCount++;
          const error: unknown = transportError();
          if (error !== undefined) throw error;
          yield { type: "finish" };
        })(),
      }),
    });

    try {
      await expect(processor.process({ system: "" })).rejects.toBeDefined();

      // The streak declines on the third instant failure: exactly three
      // attempts, and the two waits between them are probe delays, not the
      // 2s/4s exponential ladder.
      expect(attemptCount).toBe(3);
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
        Retry.INSTANT_FAILURE_PROBE_DELAY_MS,
        Retry.INSTANT_FAILURE_PROBE_DELAY_MS,
      ]);

      // Each decided delay is also published as `backoffMs` on RetryDecided
      // (src/processor/index.ts:308-317), pinning the externally visible
      // decision rather than inferring it from an elapsed-time upper bound.
      const decided = events
        .named(LlmCall.Events.RetryDecided.name)
        .map((event) => (event as { backoffMs?: number }).backoffMs);
      expect(decided).toEqual([
        Retry.INSTANT_FAILURE_PROBE_DELAY_MS,
        Retry.INSTANT_FAILURE_PROBE_DELAY_MS,
      ]);

      // A retryable error declined for a non-"non_retryable" reason must say
      // why, through the port.
      const declined = events
        .named(Operational.Events.Error.name)
        .map((event) => event as { component?: string; msg?: string; error?: string });
      const fromRetry = declined.filter((event) => event.component === "llm.retry");
      expect(fromRetry).toHaveLength(1);
      expect(fromRetry[0]?.msg).toBe("retry declined");
      expect(String(fromRetry[0]?.error)).toContain("transport");
    } finally {
      sleep.mockRestore();
    }
  });
});
