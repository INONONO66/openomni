import { describe, expect, it, jest } from "bun:test";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../../src/core/execution/events";
import { createAssistantMessage } from "../../src/core/message-factory";
import { ChatAgent } from "../../src/core/chat-agent";
import { Bus } from "../../src/index";
import { createMockLlmConfig, createStopOutcome, mockProviderData, mockProviderModel } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

function stepSnapshot(id: string, text: string, reason: "tool-calls" | "stop"): Message.WithParts {
  const message = createAssistantMessage(text, "", "session");
  return {
    ...message,
    info: { ...message.info, id },
    parts: [
      ...message.parts.map((part) => ({ ...part, messageID: id })),
      { id: `${id}-step`, sessionID: "session", messageID: id, type: "step-finish", reason, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    ],
  };
}

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

describe("mid-turn steering", () => {
  it("yields at a step boundary and continues on the next model call", async () => {
    let pending = true;
    const yielded: Array<boolean | undefined> = [];
    let calls = 0;
    const result = await ChatAgent.create({
      events: Bus,
      model,
      steeringPending: () => pending,
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (input, sink) => {
          calls += 1;
          yielded.push(input.shouldYield?.());
          if (calls === 1) { pending = false; sink.onMessage(stepSnapshot("first", "working", "tool-calls")); }
          else sink.onMessage(stepSnapshot("second", "done", "stop"));
          return createStopOutcome();
        },
      }),
    }).run(runInput([{ role: "user", content: "start" }]));
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("done");
    expect(calls).toBe(2);
    expect(yielded).toEqual([true, false]);
  });

  it("passes no steering callback when steering is absent", async () => {
    let callback: (() => boolean) | undefined;
    await ChatAgent.create({
      events: Bus,
      model,
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (input) => { callback = input.shouldYield; return createStopOutcome(); },
      }),
    }).run(runInput([{ role: "user", content: "start" }]));
    expect(callback).toBeUndefined();
  });

  it("keeps the same turn index when retrying the provider", async () => {
    jest.useFakeTimers();
    const indices: number[] = [];
    const retry = Promise.withResolvers<void>();
    const unsubscribeTurn = Bus.subscribe(RunEvents.TurnStart, (event) => indices.push(event.turnIndex));
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    let calls = 0;
    try {
      const running = ChatAgent.create({
        events: Bus,
        model,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => { calls += 1; return calls === 1 ? { type: "error", error: { message: "transient blip", name: "Error" } } : createStopOutcome(); },
        }),
      }).run(runInput([{ role: "user", content: "start" }]));
      await retry.promise;
      jest.advanceTimersByTime(1_000);
      await running;
      expect(indices).toEqual([0, 0]);
    } finally {
      unsubscribeRetry();
      unsubscribeTurn();
      jest.useRealTimers();
    }
  });
});
