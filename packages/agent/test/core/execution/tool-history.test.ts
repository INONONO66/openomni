import { providerFailure } from "../../helpers/mock-llm";
import { createTestAgent } from "../../helpers/test-agent";
import { describe, expect, it, jest } from "bun:test";
import type { Provider, Sink } from "@openomni/llm";
import { toModelMessages } from "@openomni/llm/src/message";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/execution/events";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { Bus } from "../../../src/index";
import { createStopOutcome, type MockLlmFn } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

const providerModel = {
  id: "claude-3-haiku-20240307",
  name: "Claude 3 Haiku",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic" },
} satisfies Provider.Model;

function toolSnapshot(id: string, text: string, reason: "tool-calls" | "stop"): Message.WithParts {
  const base = createAssistantMessage(text, "", "session");
  if (base.info.role !== "assistant") throw new Error("expected assistant message");
  const tool: Message.ToolPart = {
    id: `${id}-tool`,
    sessionID: "session",
    messageID: id,
    type: "tool",
    callID: "call-1",
    tool: "lookup",
    state: {
      status: "completed",
      input: { q: "answer" },
      output: "42",
      title: "lookup",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  return {
    ...base,
    info: {
      ...base.info,
      id,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      tool,
      ...base.parts.map((part) => ({ ...part, messageID: id })),
      {
        id: `${id}-step`,
        sessionID: "session",
        messageID: id,
        type: "step-finish",
        reason,
        cost: 0,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

function agent(run: MockLlmFn, steeringPending?: () => boolean) {
  return createTestAgent({
    events: Bus,
    model: { provider: "anthropic", id: providerModel.id },
    llm: { run, resolveModel: async () => providerModel },
    ...(steeringPending === undefined ? {} : { steeringPending }),
  });
}

describe("tool-bearing history", () => {
  it("feeds a completed tool call and result into the next model turn", async () => {
    const inputs: Message.WithParts[][] = [];
    let pending = true;
    let calls = 0;
    const result = await agent(
      async (input, sink: Sink) => {
        calls += 1;
        inputs.push([...(input.messages as Message.WithParts[])]);
        input.shouldYield?.();
        if (calls === 1) {
          pending = false;
          sink.onMessage(toolSnapshot("first", "answer", "tool-calls"));
        } else sink.onMessage(createAssistantMessage("done", "", "session"));
        return createStopOutcome();
      },
      () => pending,
    ).run(runInput([{ role: "user", content: "question" }]));

    expect(result.finishReason).toBe("stop");
    const second = inputs[1] ?? [];
    const assistant = second.find((message) => message.info.id === "first");
    expect(assistant?.parts.some((part) => part.type === "tool")).toBe(true);
    const provider = toModelMessages(second, providerModel);
    const toolCalls = provider
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool-call");
    const toolResults = provider
      .filter((message) => message.role === "tool")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool-result");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls.map((part) => part.toolCallId)).toEqual(["call-1"]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults.map((part) => part.toolCallId)).toEqual(["call-1"]);
    expect(toolResults[0]?.output).toEqual({ type: "text", value: "42" });
  });

  it("preserves accumulated tool history and usage across an agent retry", async () => {
    jest.useFakeTimers();
    const retry = Promise.withResolvers<void>();
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    const inputs: Message.WithParts[][] = [];
    let pending = true;
    let calls = 0;
    try {
      const running = agent(
        async (input, sink) => {
          calls += 1;
          inputs.push([...(input.messages as Message.WithParts[])]);
          if (calls === 1) {
            input.shouldYield?.();
            pending = false;
            sink.onMessage(toolSnapshot("first", "answer", "tool-calls"));
            return createStopOutcome();
          }
          if (calls === 2) return { type: "error", error: providerFailure("transient failure") };
          sink.onMessage(createAssistantMessage("done", "", "session"));
          return createStopOutcome();
        },
        () => pending,
      ).run(runInput([{ role: "user", content: "question" }]));
      await retry.promise;
      jest.advanceTimersByTime(1_000);
      const result = await running;
      expect(calls).toBe(3);
      expect(inputs).toHaveLength(3);
      expect(inputs[2]?.some((message) => message.info.id === "first")).toBe(true);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    } finally {
      unsubscribe();
      jest.useRealTimers();
    }
  });

  it("does not resurrect prior text when the next turn emits an empty snapshot", async () => {
    let pending = true;
    let calls = 0;
    const result = await agent(
      async (input, sink) => {
        calls += 1;
        if (calls === 1) {
          input.shouldYield?.();
          pending = false;
          sink.onMessage(toolSnapshot("first", "done", "tool-calls"));
        } else sink.onMessage(createAssistantMessage("", "", "session"));
        return createStopOutcome();
      },
      () => pending,
    )
      .run(runInput([{ role: "user", content: "question" }]))
      .catch((error: Error) => error);
    expect(result).toMatchObject({ code: "agent_stop", reason: "toolless_stall" });
    expect(calls).toBe(3);
  });
});
