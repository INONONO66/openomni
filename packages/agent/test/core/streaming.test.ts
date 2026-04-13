import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type { AgentEvent } from "../../src/core/types";
import {
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mock(async () => mockProviderData) },
  Provider: { fromModelsDevModel: mock(() => mockProviderModel) },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
}));

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const defaultConfig = {
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
};

const defaultInput = {
  messages: [{ role: "user" as const, content: "hello" }],
};

async function collectEvents(
  agent: ReturnType<typeof ChatAgent.create>,
  input = defaultInput,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.stream(input)) {
    events.push(event);
  }
  return events;
}

describe("ChatAgent.stream()", () => {
  it("yields text_chunk and complete events for simple response", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage({
        info: {
          id: "msg-1",
          sessionID: "test",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "",
          modelID: "claude-3-haiku-20240307",
          providerID: "anthropic",
          agent: "test",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "p1",
            sessionID: "test",
            messageID: "msg-1",
            type: "text",
            text: "Hello world",
          },
        ],
      });
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);
    const events = await collectEvents(agent);

    const types = events.map((e) => e.type);
    expect(types).toContain("text_chunk");
    expect(types).toContain("turn_complete");
    expect(types).toContain("complete");

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    if (completeEvent?.type === "complete") {
      expect(completeEvent.result.finishReason).toBe("stop");
    }
  });

  it("yields tool_call_start and tool_call_complete events", async () => {
    mockRunFn = async (input, sink) => {
      const call = { id: "call-1", tool: "test_tool", input: { q: "test" } };
      if (input.toolExecutor) {
        sink.onToolCall(call);
        const result = await input.toolExecutor(call);
        sink.onToolResult(result);
      }
      sink.onMessage({
        info: {
          id: "msg-2",
          sessionID: "test",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "",
          modelID: "claude-3-haiku-20240307",
          providerID: "anthropic",
          agent: "test",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: {
            input: 5,
            output: 3,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "p2",
            sessionID: "test",
            messageID: "msg-2",
            type: "text",
            text: "Done",
          },
        ],
      });
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      ...defaultConfig,
      toolExecutor: async (call) => ({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "tool result",
        isError: false,
      }),
    });

    const events = await collectEvents(agent);
    const types = events.map((e) => e.type);

    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_complete");
    expect(types).toContain("complete");

    const startEvent = events.find((e) => e.type === "tool_call_start");
    if (startEvent?.type === "tool_call_start") {
      expect(startEvent.toolName).toBe("test_tool");
    }
  });

  it("stream() and run() produce same finishReason", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage({
        info: {
          id: "msg-3",
          sessionID: "test",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "",
          modelID: "claude-3-haiku-20240307",
          providerID: "anthropic",
          agent: "test",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: {
            input: 5,
            output: 3,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "p3",
            sessionID: "test",
            messageID: "msg-3",
            type: "text",
            text: "Result",
          },
        ],
      });
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);

    const runResult = await agent.run(defaultInput);
    const events = await collectEvents(agent);
    const completeEvent = events.find((e) => e.type === "complete");

    expect(runResult.finishReason).toBe("stop");
    if (completeEvent?.type === "complete") {
      expect(completeEvent.result.finishReason).toBe("stop");
    }
  });
});
