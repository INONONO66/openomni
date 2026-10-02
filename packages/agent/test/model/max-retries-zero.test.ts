import { beforeEach, describe, expect, test } from "bun:test";
import { run, LlmRunFailure } from "./helpers/native";
import { mockAiModule, streamOf, type StreamTextArgs } from "./helpers/ai-mock";
import { sdkError } from "./helpers/retry";
import { Bus, newTraceId } from "./helpers/observation";
import type { Provider } from "../../src/model/provider";
import type { Sink } from "../../src/model/sink";

const sink: Sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
};

const model: Provider.Model = {
  id: "claude-3-haiku",
  providerID: "__test_max_retries__",
  name: "test",
  api: { npm: "@ai-sdk/anthropic" },
};

/**
 * Retry ownership stays with the executor's journal alarms: the SDK is handed
 * `maxRetries: 0` and a failed attempt must not trigger a second SDK call —
 * the typed failure propagates with the provider facts for classification.
 */
describe("maxRetries: 0 under ai 7", () => {
  let calls = 0;
  let capturedArgs: StreamTextArgs | undefined;

  beforeEach(() => {
    calls = 0;
    capturedArgs = undefined;
    mockAiModule({
      streamText: (args: StreamTextArgs) => {
        calls += 1;
        capturedArgs = args;
        return streamOf([
          {
            type: "error",
            error: sdkError({
              message: "overloaded",
              isRetryable: true,
              statusCode: 529,
              responseHeaders: { "retry-after-ms": "250" },
            }),
          },
        ]);
      },
    });
  });

  test("one failed attempt means exactly one SDK call and a typed failure", async () => {
    const outcome = await run(
      {
        trace: { traceId: newTraceId(), sessionId: "session-max-retries", runId: "run-max-retries" },
        events: Bus,
        messages: [],
        tools: [],
        model,
        auth: { type: "api", key: "test-key-max-retries" },
      },
      sink,
    );

    expect(calls).toBe(1);
    expect(capturedArgs?.maxRetries).toBe(0);
    expect(outcome.type).toBe("error");
    if (outcome.type !== "error") throw new Error("expected a typed failure outcome");
    expect(outcome.error).toBeInstanceOf(LlmRunFailure);
    expect(outcome.error).toMatchObject({
      aborted: false,
      retryAfterMs: 250,
      cause: { statusCode: 529, isRetryable: true },
    });
  });
});
