import { describe, expect, test } from "bun:test";
import { LlmCall } from "../src/event/llm.js";

describe("LlmCall BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  test("Completed parses valid token counts", () => {
    expect(() =>
      LlmCall.Completed.schema.parse({
        ...base,
        provider: "openai",
        model: "gpt-4o",
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        finishReason: "stop",
      }),
    ).not.toThrow();
  });

  test("Completed rejects negative and fractional token counts", () => {
    const valid = {
      ...base,
      provider: "openai",
      model: "gpt-4o",
      durationMs: 100,
      outputTokens: 50,
      finishReason: "stop",
    };

    expect(() => LlmCall.Completed.schema.parse({ ...valid, inputTokens: -1 })).toThrow();
    expect(() => LlmCall.Completed.schema.parse({ ...valid, inputTokens: 1.5 })).toThrow();
  });
});
