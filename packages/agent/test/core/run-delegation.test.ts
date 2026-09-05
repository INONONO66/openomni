import { describe, expect, it } from "bun:test";
import { createAssistantMessage } from "../../src/core/message-factory";
import { ChatAgent } from "../../src/core/chat-agent";
import { Bus } from "../../src/index";
import { createMockLlmConfig, createStopOutcome, mockProviderData, mockProviderModel, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

function agent(run: MockLlmFn) {
  return ChatAgent.create({
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run,
    }),
  });
}

describe("run delegation result contract", () => {
  it("returns stop, text, steps, and usage from the terminal assistant snapshot", async () => {
    const result = await agent(async (_input, sink) => {
      const message = createAssistantMessage("the answer is 42", "", "session");
      if (message.info.role !== "assistant") throw new Error("expected assistant message");
      sink.onMessage({
        ...message,
        info: { ...message.info, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
      });
      return createStopOutcome();
    }).run(runInput([{ role: "user", content: "hello" }]));
    expect(result).toMatchObject({
      finishReason: "stop",
      text: "the answer is 42",
      steps: [{ type: "text", content: "the answer is 42" }],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
  });

  it("returns max-steps without calling the provider when the turn budget is zero", async () => {
    let calls = 0;
    const configured = ChatAgent.create({
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      budget: { maxTurns: 0 },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => { calls += 1; return createStopOutcome(); },
      }),
    });
    expect((await configured.run(runInput([{ role: "user", content: "hello" }]))).finishReason).toBe("max-steps");
    expect(calls).toBe(0);
  });

  it("propagates a terminal validation error", async () => {
    await expect(agent(async () => ({ type: "error", error: { name: "Error", message: "validation failed" } })).run(
      runInput([{ role: "user", content: "hello" }]),
    )).rejects.toThrow("validation failed");
  });
});
