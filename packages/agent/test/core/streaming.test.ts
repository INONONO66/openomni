import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Tool } from "@openomni/protocol";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { Bus } from "../../src/index";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockLlm = createMockLlmConfig({
  getModels: mock(async () => mockProviderData),
  fromModelsDevModel: mock(() => mockProviderModel),
  run: (input, sink: Sink) => mockRunFn(input, sink),
});

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const defaultConfig = {
  events: Bus,
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

const defaultInput = runInput([{ role: "user" as const, content: "hello" }]);

/**
 * The caller's view of a run in progress, and since #621 the only one: the
 * `AgentEvent` generator that narrated the same facts had no consumer outside
 * these tests. What a caller can observe is exactly what reaches the sink it
 * passed, plus the result it is returned.
 */
function collectingSink(): Sink & {
  readonly texts: string[];
  readonly toolCalls: Tool.Call[];
  readonly toolResults: Tool.Result[];
} {
  const texts: string[] = [];
  const toolCalls: Tool.Call[] = [];
  const toolResults: Tool.Result[] = [];
  return {
    texts,
    toolCalls,
    toolResults,
    onMessage: (message) => {
      for (const part of message.parts) {
        if (part.type === "text") texts.push(part.text);
      }
    },
    onToolCall: (call) => toolCalls.push(call),
    onToolResult: (result) => toolResults.push(result),
  };
}

describe("ChatAgent.run() streaming", () => {
  it("streams assistant text to the sink and returns the result", async () => {
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

    const sink = collectingSink();
    const result = await ChatAgent.create(defaultConfig).run(defaultInput, sink);

    expect(sink.texts).toEqual(["Hello world"]);
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Hello world");
  });

  it("streams tool calls and their results to the sink", async () => {
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

    const sink = collectingSink();
    const result = await agent.run(defaultInput, sink);

    expect(sink.toolCalls.map((call) => call.tool)).toEqual(["test_tool"]);
    expect(sink.toolResults.map((r) => r.output)).toEqual(["tool result"]);
    expect(result.finishReason).toBe("stop");
  });
});
