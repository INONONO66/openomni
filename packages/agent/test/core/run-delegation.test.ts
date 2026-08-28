import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/llm";
import {
  createStopOutcome,
  createErrorOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";
import { allow, abortRun, continueWithPrompt, replaceMessages } from "../helpers/policy-decision";
import { runInput } from "../helpers/run-input";
import { Bus } from "@openomni/telemetry";

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
      middleware: [
        {
          kind: "point",
          name: "test:post-turn-stalled",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.abort"] },
          priority: 100,
          fn: () => abortRun("test.stalled", "stalled"),
        },
      ],
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
    const firstStep = result.steps[0];
    if (!firstStep) throw new Error("expected first step");
    expect(firstStep.type).toBe("text");
    expect(firstStep.content).toBe("step content");
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
      middleware: [
        {
          kind: "point",
          name: "test:post-turn-deny",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.abort"] },
          priority: 100,
          fn: () => abortRun("test.policy", "policy-violation"),
        },
      ],
    });
    const result = await agent.run(defaultInput);

    expect(result.guardAborted).toBe(true);
    expect(result.finishReason).toBe("stop");
  });

  it("throws when the LLM returns a fatal error outcome", async () => {
    mockRunFn = async () => createErrorOutcome("connection refused");

    // Zero the backoff through the run.retry_after effect seam: the subject
    // is the terminal classification after the retry ceiling, not the
    // wall-clock wait (1s + 2s by default).
    const agent = ChatAgent.create({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:no-backoff",
          pointIds: ["run.error.error"],
          effectCapabilities: { "run.error.error": ["run.retry_after"] },
          priority: 100,
          fn: () =>
            allow("test.no-backoff", "no_backoff", [{ type: "run.retry_after", delayMs: 0 }]),
        },
      ],
    });

    await expect(agent.run(defaultInput)).rejects.toThrow("connection refused");
  });

  it("preserves accumulated usage when error middleware aborts", async () => {
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
          kind: "point",
          name: "test:error_abort",
          pointIds: ["run.error.error"],
          effectCapabilities: { "run.error.error": ["run.abort"] },
          priority: 100,
          fn: (ctx) => {
            seenUsage = ctx.usage;
            return abortRun("test.error", "stop");
          },
        },
      ],
    });

    const result = await agent.run(defaultInput);

    expect(seenUsage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
    expect(result.text).toBe("partial");
  });

  it("tracks compactionCount when a completion.prepare middleware transforms messages", async () => {
    let turnCount = 0;

    mockRunFn = async (_input, sink) => {
      turnCount++;
      sink.onMessage(makeAssistantMessage(`turn ${turnCount}`));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:post-turn-inject",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.continue_with_prompt"] },
          priority: 100,
          fn: () =>
            turnCount < 2
              ? continueWithPrompt("continue", "test.post-turn", "continue-for-compaction")
              : allow("test.continue"),
        },
        {
          kind: "point",
          name: "test:force-compaction",
          pointIds: ["run.completion.pre"],
          effectCapabilities: { "run.completion.pre": ["run.replace_messages"] },
          priority: 1,
          fn: () => replaceMessages([], "test.force-compaction", "force-compaction"),
        },
      ],
    });

    const result = await agent.run(defaultInput);

    expect(result.compactionCount).toBe(1);
  });
});
