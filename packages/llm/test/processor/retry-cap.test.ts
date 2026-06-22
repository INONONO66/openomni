import { afterEach, describe, expect, test } from "bun:test";
import { LlmCall, type Message } from "@openomni/protocol";
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
});
