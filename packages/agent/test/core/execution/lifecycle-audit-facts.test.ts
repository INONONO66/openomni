import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/execution/events";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { runAgent } from "../../../src/core/execution/run";
import { Bus } from "../../../src/index";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

function measuredMessage(outputTokens: number): Message.WithParts {
  const message = createAssistantMessage("ok", "", "audit-session");
  if (message.info.role !== "assistant") throw new Error("expected assistant message");
  return {
    ...message,
    info: {
      ...message.info,
      tokens: { input: 0, output: outputTokens, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

describe("canonical lifecycle audit facts", () => {
  it("reports current-response tokens rather than cumulative run tokens", async () => {
    const responseTokens: number[] = [];
    const done = Promise.withResolvers<void>();
    const unsubscribe = Bus.subscribe(RunEvents.TurnComplete, (event) => {
      responseTokens.push(event.usage.outputTokens);
      if (responseTokens.length === 2) done.resolve();
    });
    let calls = 0;
    try {
      await runAgent(runInput([{ role: "user", content: "continue once" }]), {
        events: Bus,
        model: { provider: "test", id: "model" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async (_input, sink) => {
            calls += 1;
            sink.onMessage(measuredMessage(calls === 1 ? 3 : 4));
            return calls === 1 ? { type: "continue" } : { type: "stop" };
          },
        }),
      });
      await done.promise;
      expect(responseTokens).toEqual([3, 4]);
    } finally {
      unsubscribe();
    }
  });
});
