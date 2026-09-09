import { createTestAgent, runUserMessage } from "../helpers/test-agent";
import { describe, expect, it, jest } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/execution/events";
import { createAssistantMessage } from "../../src/core/message-factory";
import { Bus } from "../../src/index";
import { createStopOutcome, providerFailure, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { stepSnapshot } from "../helpers/messages";

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

function fallbackHarness(errorMessage: string) {
  const resolved: Model.Ref[] = [];
  let calls = 0;
  const run: MockLlmFn = async (_input, sink: Sink) => {
    calls += 1;
    if (calls === 1)
      return {
        type: "error",
        error: providerFailure(
          errorMessage,
          errorMessage === "validation failed" ? { retryable: false, statusCode: 400 } : {},
        ),
      };
    sink.onMessage(createAssistantMessage("recovered", "", "session"));
    return createStopOutcome();
  };
  return {
    resolved,
    llm: {
      run,
      resolveModel: async (model: Model.Ref) => {
        resolved.push(model);
        return { id: model.id, name: model.id, providerID: model.provider };
      },
    },
  };
}

async function afterFirstRetry<T>(operation: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  const retry = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
  try {
    const running = operation();
    await retry.promise;
    jest.advanceTimersByTime(1_000);
    return await running;
  } finally {
    unsubscribe();
    jest.useRealTimers();
  }
}

describe("model fallback via placement", () => {
  for (const scenario of [
    { reason: "transient blip", expected: [primary, fallback] },
    { reason: "tool exploded", expected: [primary, fallback] },
    { reason: "validation failed", expected: [primary, fallback] },
  ]) {
    it(`selects the expected retry model for ${scenario.reason}`, async () => {
      const { resolved, llm } = fallbackHarness(scenario.reason);
      const result = await afterFirstRetry(() =>
        runUserMessage({ events: Bus, model: primary, modelFallbacks: [fallback], llm }, "go"),
      );
      expect(result.finishReason).toBe("stop");
      expect(resolved).toEqual(scenario.expected);
    });
  }

  it("keeps validation failures terminal without a fallback", async () => {
    const { resolved, llm } = fallbackHarness("validation failed");
    await expect(
      createTestAgent({ events: Bus, model: primary, llm }).run(
        runInput([{ role: "user", content: "go" }]),
      ),
    ).rejects.toThrow("validation failed");
    expect(resolved).toEqual([primary]);
  });

  it("re-arms window yield after switching models", async () => {
    const arms: Array<number | undefined> = [];
    let calls = 0;
    const llm = {
      run: (async (input, sink: Sink) => {
        calls += 1;
        arms.push(input.yieldAtInputTokens);
        if (calls === 1) {
          sink.onMessage(stepSnapshot("first", "working", "tool-calls", 10, 5));
          return createStopOutcome();
        }
        if (calls === 2) return { type: "error", error: providerFailure("transient blip") };
        sink.onMessage(stepSnapshot("third", "done", "stop", 10, 5));
        return createStopOutcome();
      }) as MockLlmFn,
      resolveModel: async (model: Model.Ref) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
        limit: { context: model.id === primary.id ? 1_000 : 500, output: 1_000 },
      }),
    };
    const result = await afterFirstRetry(() =>
      runUserMessage({ events: Bus, model: primary, modelFallbacks: [fallback], llm }, "go"),
    );
    expect(result.finishReason).toBe("stop");
    expect(arms).toEqual([450, undefined, 225]);
  });
});
