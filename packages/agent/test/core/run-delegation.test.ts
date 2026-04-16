import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import {
  createStopOutcome,
  createErrorOutcome,
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
  ProviderTransform: {
    resolveVariant: () => ({}),
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

function makeAssistantMessage(text: string, inputTokens = 0, outputTokens = 0) {
  return {
    info: {
      id: `msg-${Math.random().toString(16).slice(2)}`,
      sessionID: "test",
      role: "assistant" as const,
      time: { created: Date.now() },
      parentID: "",
      modelID: "claude-3-haiku-20240307",
      providerID: "anthropic",
      agent: "test",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `part-${Math.random().toString(16).slice(2)}`,
        sessionID: "test",
        messageID: "msg",
        type: "text" as const,
        text,
      },
    ],
  };
}

describe("run() delegation contract", () => {
  it("returns finishReason 'stop' on normal LLM completion", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);
    const result = await agent.run(defaultInput);

    expect(result.finishReason).toBe("stop");
  });

  it("returns finishReason 'max-steps' when turn budget is exhausted", async () => {
    mockRunFn = async () => createStopOutcome();

    const agent = ChatAgent.create({ ...defaultConfig, budget: { maxTurns: 0 } });
    const result = await agent.run(defaultInput);

    expect(result.finishReason).toBe("max-steps");
  });

  it("returns finishReason 'stalled' when post-turn middleware aborts with stalled reason", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("stalling..."));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      ...defaultConfig,
      hooks: {
        postTurn: () => ({ action: "abort", reason: "stalled" }),
      },
    });
    const result = await agent.run(defaultInput);

    expect(result.finishReason).toBe("stalled");
    expect(result.guardAborted).not.toBe(true);
  });

  it("returns the final assistant text in result.text", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("the answer is 42"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);
    const result = await agent.run(defaultInput);

    expect(result.text).toBe("the answer is 42");
  });

  it("populates steps array with at least one text step on normal completion", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("step content"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);
    const result = await agent.run(defaultInput);

    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps[0].type).toBe("text");
    expect(result.steps[0].content).toBe("step content");
  });

  it("accumulates token usage from assistant messages", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("tokens", 20, 10));
      return createStopOutcome();
    };

    const agent = ChatAgent.create(defaultConfig);
    const result = await agent.run(defaultInput);

    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.usage.totalTokens).toBe(30);
  });

  it("sets guardAborted=true when post-turn middleware aborts with non-stalled reason", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("blocked"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      ...defaultConfig,
      hooks: {
        postTurn: () => ({ action: "abort", reason: "policy-violation" }),
      },
    });
    const result = await agent.run(defaultInput);

    expect(result.guardAborted).toBe(true);
    expect(result.finishReason).toBe("stop");
  });

  it("throws when the LLM returns a fatal error outcome", async () => {
    mockRunFn = async () => createErrorOutcome("connection refused");

    const agent = ChatAgent.create(defaultConfig);

    await expect(agent.run(defaultInput)).rejects.toThrow("connection refused");
  });

  it("preserves accumulated usage when on_error middleware aborts", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(makeAssistantMessage("partial", 9, 4));
      return createErrorOutcome("connection refused");
    };

    let seenUsage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        }
      | undefined;

    const agent = ChatAgent.create({
      ...defaultConfig,
      middleware: [
        {
          name: "test:on_error_abort",
          timing: "on_error",
          priority: 100,
          fn: (ctx) => {
            seenUsage = ctx.usage;
            return { action: "abort" as const, reason: "stop" };
          },
        },
      ],
    });

    const result = await agent.run(defaultInput);

    expect(seenUsage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
    expect(result.text).toBe("partial");
  });

  it("tracks compactionCount when a post_compaction middleware transforms messages", async () => {
    let turnCount = 0;

    mockRunFn = async (_input, sink) => {
      turnCount++;
      sink.onMessage(makeAssistantMessage(`turn ${turnCount}`));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      ...defaultConfig,
      hooks: {
        postTurn: () =>
          turnCount < 2 ? { action: "inject", message: "continue" } : { action: "continue" },
      },
      middleware: [
        {
          name: "test:force-compaction",
          timing: "post_compaction",
          priority: 1,
          fn: async () => ({
            action: "transform" as const,
            input: { messages: [] as unknown[] },
          }),
        },
      ],
    });

    const result = await agent.run(defaultInput);

    expect(result.compactionCount).toBe(1);
  });
});
