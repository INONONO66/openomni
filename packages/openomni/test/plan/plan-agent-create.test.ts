import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";

// --- Mock setup (must be before dynamic import) ---

type MockLlmFn = (input: any, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async () => ({ type: "stop" });

const mockModelsGet = mock(async () => ({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
    },
  },
}));

const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: (input: any, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

// --- Dynamic import after mock ---

let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;
beforeAll(async () => {
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
});

afterAll(() => {
  mock.restore();
});

// --- Helpers ---

const MODEL = { provider: "anthropic", id: "claude-3-haiku-20240307" };

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "plan-create-test";
  const now = Date.now();
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "chat-agent",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [textPart] };
}

function setupMockResponse(text: string) {
  mockRunFn = async (_input: any, sink: Sink) => {
    sink.onMessage(createAssistantMessage(text));
    return { type: "stop" } as Run.Outcome;
  };
}

beforeEach(() => {
  mockRunFn = async () => ({ type: "stop" }) as Run.Outcome;
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
});

// --- Tests ---

describe("PlanAgent.create", () => {
  it("returns a ChatAgentInstance with run and stream methods", () => {
    const agent = PlanAgent.create({ model: MODEL });

    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  it("agent.run() completes with plan_write tool call", async () => {
    let callCount = 0;
    mockRunFn = async (_input: any, sink: Sink) => {
      callCount++;
      if (callCount === 1) {
        // First call: LLM returns a plan_write tool call
        sink.onMessage(createAssistantMessage(""));
        return {
          type: "await_tool",
          toolCalls: [
            {
              id: "tc-1",
              tool: "plan_write",
              input: { planId: "p1", content: "# My Plan\n- Step 1" },
            },
          ],
        } as Run.Outcome;
      }
      // Second call: LLM stops
      sink.onMessage(createAssistantMessage("Plan written successfully."));
      return { type: "stop" } as Run.Outcome;
    };

    const agent = PlanAgent.create({ model: MODEL });
    const result = await agent.run({
      messages: [{ role: "user", content: "Create a plan" }],
    });

    expect(result.finishReason).toBe("stop");
    expect(callCount).toBe(2);
  });

  it("routes external tool calls to custom toolExecutor", async () => {
    const executorCalls: string[] = [];
    const customExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
      executorCalls.push(call.tool);
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "custom result",
        isError: false,
      };
    };

    const extraTool: Tool.Spec = {
      name: "search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      safe: true,
    };

    let callCount = 0;
    mockRunFn = async (_input: any, sink: Sink) => {
      callCount++;
      if (callCount === 1) {
        sink.onMessage(createAssistantMessage(""));
        return {
          type: "await_tool",
          toolCalls: [{ id: "tc-ext", tool: "search", input: { query: "hello" } }],
        } as Run.Outcome;
      }
      sink.onMessage(createAssistantMessage("Done."));
      return { type: "stop" } as Run.Outcome;
    };

    const agent = PlanAgent.create({
      model: MODEL,
      tools: [extraTool],
      toolExecutor: customExecutor,
    });

    const result = await agent.run({
      messages: [{ role: "user", content: "Search something" }],
    });

    expect(result.finishReason).toBe("stop");
    expect(executorCalls).toContain("search");
  });

  it("routes plan_-prefixed custom tools to user executor, not plan executor", async () => {
    const executorCalls: string[] = [];
    const customExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
      executorCalls.push(call.tool);
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "custom handled",
        isError: false,
      };
    };

    const customTool: Tool.Spec = {
      name: "plan_review",
      description: "Custom review tool with plan_ prefix",
      inputSchema: { type: "object", properties: {}, required: [] },
      safe: true,
    };

    let callCount = 0;
    mockRunFn = async (_input: any, sink: Sink) => {
      callCount++;
      if (callCount === 1) {
        sink.onMessage(createAssistantMessage(""));
        return {
          type: "await_tool",
          toolCalls: [{ id: "tc-pr", tool: "plan_review", input: {} }],
        } as Run.Outcome;
      }
      sink.onMessage(createAssistantMessage("Done."));
      return { type: "stop" } as Run.Outcome;
    };

    const agent = PlanAgent.create({
      model: MODEL,
      tools: [customTool],
      toolExecutor: customExecutor,
    });

    await agent.run({ messages: [{ role: "user", content: "review" }] });

    expect(executorCalls).toContain("plan_review");
  });

  it("returns error result for unknown external tool without executor", async () => {
    let callCount = 0;
    let toolResultOutput = "";

    mockRunFn = async (_input: any, sink: Sink) => {
      callCount++;
      if (callCount === 1) {
        sink.onMessage(createAssistantMessage(""));
        return {
          type: "await_tool",
          toolCalls: [{ id: "tc-unknown", tool: "unknown_tool", input: {} }],
        } as Run.Outcome;
      }
      sink.onMessage(createAssistantMessage("Done."));
      return { type: "stop" } as Run.Outcome;
    };

    const agent = PlanAgent.create({ model: MODEL });

    const sink: Sink = {
      onMessage: () => {},
      onToolCall: () => {},
      onToolResult: (result) => {
        toolResultOutput = result.output;
      },
      onSnapshot: () => {},
    };

    const result = await agent.run({ messages: [{ role: "user", content: "test" }] }, sink);

    expect(result.finishReason).toBe("stop");
    expect(toolResultOutput).toContain("No executor for tool");
  });
});

describe("PlanAgent.generate (regression)", () => {
  it("still returns PlanResult when LLM returns valid plan JSON", async () => {
    const goal = "Build API gateway";
    const now = new Date().toISOString();
    setupMockResponse(
      JSON.stringify({
        planId: "plan-1",
        goal,
        steps: [
          {
            stepId: "s1",
            description: "Design routes",
            expectedOutput: "Route map",
            dependsOn: [],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    );

    const result = await PlanAgent.generate(goal, { model: MODEL });

    expect(result.plan.planId).toBe("plan-1");
    expect(result.plan.goal).toBe(goal);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.createdAt).toBeInstanceOf(Date);
  });
});
