import { describe, expect, it, jest } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Message, Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/execution/events";
import { createAssistantMessage } from "../../src/core/message-factory";
import { ChatAgent } from "../../src/core/chat-agent";
import { Bus } from "../../src/index";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

function stepSnapshot(id: string, text: string, reason: "tool-calls" | "stop"): Message.WithParts {
  const message = createAssistantMessage(text, "", "session");
  return {
    ...message,
    info: { ...message.info, id },
    parts: [
      ...message.parts.map((part) => ({ ...part, messageID: id })),
      { id: `${id}-step`, sessionID: "session", messageID: id, type: "step-finish", reason, cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    ],
  };
}

function fallbackHarness(errorMessage: string) {
  const resolved: Model.Ref[] = [];
  let calls = 0;
  const run: MockLlmFn = async (_input, sink: Sink) => {
    calls += 1;
    if (calls === 1) return { type: "error", error: { message: errorMessage, name: "Error" } };
    sink.onMessage(createAssistantMessage("recovered", "", "session"));
    return createStopOutcome();
  };
  return {
    resolved,
    llm: {
      run,
      resolveProviderModel: async (model: Model.Ref) => {
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
    { reason: "tool exploded", expected: [primary, primary] },
    { reason: "validation failed", expected: [primary, fallback] },
  ]) {
    it(`selects the expected retry model for ${scenario.reason}`, async () => {
      const { resolved, llm } = fallbackHarness(scenario.reason);
      const result = await afterFirstRetry(() => ChatAgent.create({ events: Bus, model: primary, modelFallbacks: [fallback], llm }).run(runInput([{ role: "user", content: "go" }])));
      expect(result.finishReason).toBe("stop");
      expect(resolved).toEqual(scenario.expected);
    });
  }

  it("keeps validation failures terminal without a fallback", async () => {
    const { resolved, llm } = fallbackHarness("validation failed");
    await expect(ChatAgent.create({ events: Bus, model: primary, llm }).run(runInput([{ role: "user", content: "go" }]))).rejects.toThrow("validation failed");
    expect(resolved).toEqual([primary]);
  });

  it("re-arms window yield after switching models", async () => {
    const arms: Array<number | undefined> = [];
    let calls = 0;
    const llm = {
      run: (async (input, sink: Sink) => {
        calls += 1;
        arms.push(input.yieldAtInputTokens);
        if (calls === 1) { sink.onMessage(stepSnapshot("first", "working", "tool-calls")); return createStopOutcome(); }
        if (calls === 2) return { type: "error", error: { message: "transient blip", name: "Error" } };
        sink.onMessage(stepSnapshot("third", "done", "stop"));
        return createStopOutcome();
      }) as MockLlmFn,
      resolveProviderModel: async (model: Model.Ref) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
        limit: { context: model.id === primary.id ? 1_000 : 500, output: 1_000 },
      }),
    };
    const result = await afterFirstRetry(() => ChatAgent.create({ events: Bus, model: primary, modelFallbacks: [fallback], llm }).run(runInput([{ role: "user", content: "go" }])));
    expect(result.finishReason).toBe("stop");
    expect(arms).toEqual([450, undefined, 225]);
  });
});
