import { afterEach, describe, expect, test } from "bun:test";
import { Operational, type Message } from "@openomni/protocol";
import { collector } from "@openomni/telemetry";
import { APIError } from "../../src/error";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "msg-instant-streak",
    sessionID: "session-instant-streak",
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-instant-streak",
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
    const processor = Processor.create({
      assistantMessage: assistantMessage(),
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

    const startedAt = Date.now();
    await expect(processor.process({ system: "" })).rejects.toBeDefined();
    const elapsed = Date.now() - startedAt;

    // The streak declines on the third instant failure: exactly three
    // attempts, and the two waits between them are probe delays, not the
    // 2s/4s exponential ladder (which alone would exceed 6s here).
    expect(attemptCount).toBe(3);
    expect(elapsed).toBeLessThan(2000);

    // A retryable error declined for a non-"non_retryable" reason must say
    // why, through the port.
    const declined = events
      .named(Operational.Error.name)
      .map((event) => event as { component?: string; msg?: string; error?: string });
    const fromRetry = declined.filter((event) => event.component === "llm.retry");
    expect(fromRetry).toHaveLength(1);
    expect(fromRetry[0]?.msg).toBe("retry declined");
    expect(String(fromRetry[0]?.error)).toContain("transport");
  });
});
