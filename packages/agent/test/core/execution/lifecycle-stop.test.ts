import { describe, expect, it } from "bun:test";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { runAgent } from "../../../src/core/execution/run";
import { Bus } from "../../../src/index";
import { createMockLlmConfig, createStopOutcome, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

describe("run stop outcomes", () => {
  it("returns the current turn text and records one text step", async () => {
    const result = await runAgent(runInput([{ role: "user", content: "hello" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (_input, sink) => { sink.onMessage(createAssistantMessage("original", "", "session")); return createStopOutcome(); },
      }),
    });
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("original");
    expect(result.steps).toEqual([{ type: "text", content: "original" }]);
  });

  it("does not resurrect prior text when a later continuation snapshot is empty", async () => {
    let calls = 0;
    const result = await runAgent(runInput([{ role: "user", content: "hello" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (_input, sink) => {
          calls += 1;
          if (calls === 1) {
            sink.onMessage(createAssistantMessage("first", "", "session"));
            return { type: "continue" };
          }
          sink.onMessage(createAssistantMessage("", "", "session"));
          return createStopOutcome();
        },
      }),
    });
    expect(result.text).toBe("");
    expect(result.steps).toEqual([{ type: "text", content: "" }]);
  });
});
