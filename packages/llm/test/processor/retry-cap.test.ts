import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  anthropicModel as model,
  assistantMessage as buildAssistantMessage,
} from "../helpers/fixtures";
import { LlmCall, Operational, type Transcript } from "@openomni/protocol";
import { Bus, collector } from "../helpers/observation";
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

  test("records synchronous stream failure before process promise settlement", async () => {
    const failure = new Error("synchronous stream failure");
    const facts: Transcript.Fact[] = [];
    const publish = spyOn(Bus, "publish");
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-sync", "session-sync", "parent-sync"),
      sessionID: "session-sync",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 0,
      events: Bus,
      sink: {
        onMessage: () => undefined,
        onFact: (fact) => facts.push(fact),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      createStream: () => {
        throw failure;
      },
      trace: { traceId: "trace-sync", sessionId: "session-sync" },
    });

    try {
      const processing = processor.process({ system: "", promptText: "" });
      const rejection = processing.catch((error) => error);
      expect(facts.map((fact) => fact.type)).toEqual(["message.created", "message.finished"]);
      expect(facts[1]).toMatchObject({ type: "message.finished", finish: "error" });
      expect(
        publish.mock.calls
          .filter((call) => call[0] === Operational.Events.Info)
          .map((call) => (call[1] as { context?: { stateType?: string } }).context?.stateType)
          .filter((state): state is string => state !== undefined),
      ).toEqual(["busy", "idle"]);
      expect(await rejection).toBe(failure);
    } finally {
      publish.mockRestore();
    }
  });

  test("records rejected createStream promises in the first rejection continuation", async () => {
    const failure = new Error("rejected createStream promise");
    const facts: Transcript.Fact[] = [];
    const publish = spyOn(Bus, "publish");
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-rejected", "session-rejected", "parent"),
      sessionID: "session-rejected",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 0,
      events: Bus,
      sink: {
        onMessage: () => undefined,
        onFact: (fact) => facts.push(fact),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      createStream: () => Promise.reject(failure),
      trace: { traceId: "trace-rejected", sessionId: "session-rejected" },
    });

    try {
      const processing = processor.process({ system: "", promptText: "" });
      const rejection = processing.catch((error) => error);
      await Promise.resolve();
      expect(facts.map((fact) => fact.type)).toEqual(["message.created", "message.finished"]);
      expect(
        publish.mock.calls
          .filter((call) => call[0] === Operational.Events.Info)
          .map((call) => (call[1] as { context?: { stateType?: string } }).context?.stateType)
          .filter((state): state is string => state !== undefined),
      ).toEqual(["busy", "idle"]);
      expect(await rejection).toBe(failure);
    } finally {
      publish.mockRestore();
    }
  });

  test("publishes idle only after a synchronous retryable failure settles", async () => {
    let attemptCount = 0;
    let markSecondAttemptStarted!: () => void;
    const secondAttemptStarted = new Promise<void>((resolve) => {
      markSecondAttemptStarted = resolve;
    });
    let settleSecondAttempt!: () => void;
    const secondAttemptSettlement = new Promise<void>((resolve) => {
      settleSecondAttempt = resolve;
    });
    const sleep = spyOn(Retry, "sleep").mockResolvedValue(undefined);
    const publish = spyOn(Bus, "publish");
    const statusStates = () =>
      publish.mock.calls
        .filter((call) => call[0] === Operational.Events.Info)
        .map((call) => (call[1] as { context?: { stateType?: string } }).context?.stateType)
        .filter((state): state is string => state !== undefined);
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-sync-retry", "session-sync-retry", "parent"),
      sessionID: "session-sync-retry",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 1,
      events: Bus,
      createStream: () => {
        attemptCount++;
        if (attemptCount === 1) throw rateLimitError();
        markSecondAttemptStarted();
        return secondAttemptSettlement.then(() => ({
          fullStream: (async function* () {
            yield { type: "finish" };
          })(),
        }));
      },
      trace: { traceId: "trace-sync-retry", sessionId: "session-sync-retry" },
    });

    const processing = processor.process({ system: "", promptText: "" });
    try {
      expect(statusStates()).toEqual(["busy", "retry"]);
      await secondAttemptStarted;
      expect(statusStates()).toEqual(["busy", "retry"]);
      settleSecondAttempt();
      await processing;
      expect(statusStates()).toEqual(["busy", "retry", "idle"]);
      expect(attemptCount).toBe(2);
    } finally {
      settleSecondAttempt();
      await processing.catch(() => undefined);
      publish.mockRestore();
      sleep.mockRestore();
    }
  });

  test("stops retrying after configured retry cap", async () => {
    const retryErrors = [rateLimitError(), rateLimitError(), rateLimitError()];
    let attemptCount = 0;
    const events = collector();
    const sleep = spyOn(Retry, "sleep").mockResolvedValue(undefined);

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage(
        "msg-retry-cap",
        "session-retry-cap",
        "parent-retry-cap",
      ),
      sessionID: "session-retry-cap",
      model,
      abort: new AbortController().signal,
      maxRetryAttempts: 2,
      trace: {
        traceId: "trace-processor-retry-cap",
        sessionId: "session-retry-cap",
      },
      events,
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
      await processor.process({ system: "", promptText: "" });
      expect.unreachable("Should have thrown the retry error that exceeded the cap");
    } catch (e) {
      expect(e).toBe(retryErrors[2]);
    }

    expect(attemptCount).toBe(3);
    // Exact sequence of requested delays: the retry-after-ms header provides "1ms" delays.
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1, 1]);
    const retries = (
      events.named(LlmCall.Events.RetryDecided.name) as Array<{ maxAttempts: number }>
    ).map((event) => event.maxAttempts);
    expect(retries).toEqual([2, 2]);
    // Pin (#606 audit): budget exhaustion is a decline too — it must say why.
    const exhausted = (
      events.named(Operational.Events.Error.name) as Array<{ msg: string; error?: string }>
    )
      .filter((event) => event.msg === "retry attempts exhausted")
      .map((event) => event.error);
    expect(exhausted).toEqual(["rate_limit: attempt cap 2 exceeded"]);
    sleep.mockRestore();
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

    const events = collector();
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
      events,
      trace: { traceId: "trace-retry-cap", sessionId: "session-retry-cap" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "t" };
          throw serverError;
        })(),
      }),
    });

    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(serverError);

    const decisions = (
      events.named(Operational.Events.Error.name) as Array<{
        traceId: string;
        time: number;
        sessionId?: string;
        component: string;
        msg: string;
        error?: string;
      }>
    ).filter((event) => event.component === "llm.retry");
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
      await expect(processor.process({ system: "", promptText: "" })).rejects.toBeDefined();

      // The streak declines on the third instant failure: exactly three
      // attempts, and the two waits between them are probe delays, not the
      // 2s/4s exponential ladder.
      expect(attemptCount).toBe(3);
      // 250ms is the externally required short-probe contract. Keep the
      // expectation independent of the production constant so drift is loud.
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 250]);

      // Each decided delay is also published as `backoffMs` on RetryDecided
      // (src/processor/index.ts:308-317), pinning the externally visible
      // decision rather than inferring it from an elapsed-time upper bound.
      const decided = events
        .named(LlmCall.Events.RetryDecided.name)
        .map((event) => (event as { backoffMs?: number }).backoffMs);
      expect(decided).toEqual([250, 250]);

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
