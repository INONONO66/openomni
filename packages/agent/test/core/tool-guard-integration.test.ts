import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Run, Sink, Tool } from "@openomni/protocol";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockModelsGet = mock(async () => mockProviderData);
const mockProviderFromModelsDevModel = mock(() => mockProviderModel);

const mockLlm = createMockLlmConfig({
  getModels: mockModelsGet,
  fromModelsDevModel: mockProviderFromModelsDevModel,
  run: (input, sink: Sink) => mockRunFn(input, sink),
});

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

function createAssistantMessage(text: string) {
  const id = `msg-${Math.random().toString(16).slice(2)}`;
  const sessionID = "tool-guard-integration-test";
  const now = Date.now();

  return {
    info: {
      id,
      sessionID,
      role: "assistant" as const,
      time: { created: now },
      parentID: "",
      modelID: "claude-3-haiku-20240307",
      providerID: "anthropic",
      agent: "chat-agent",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `part-${Math.random().toString(16).slice(2)}`,
        sessionID,
        messageID: id,
        type: "text" as const,
        text,
      },
    ],
  };
}

function createToolCall(id: string, tool = "bash", input: Record<string, unknown> = {}): Tool.Call {
  return { id, tool, input };
}

async function executeTool(input: unknown, call: Tool.Call): Promise<Tool.Result> {
  const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
  if (!runInput.toolExecutor) throw new Error("expected tool executor");
  return runInput.toolExecutor(call);
}

function newID(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}

function resetMocks() {
  mockRunFn = async () => createStopOutcome();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
}

describe("ToolGuard integration via toolExecutor", () => {
  it("deny blocks tool execution in run()", async () => {
    resetMocks();
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      };
    });

    let observedToolResult: Tool.Result | undefined;
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const call = createToolCall("call-deny", "bash", { command: "rm -rf /" });
      const result = await executeTool(input, call);
      sink.onToolCall(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      tools: [
        {
          name: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      toolExecutor: executor,
      permissions: {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "rm\\s+-rf",
            action: "deny",
            priority: 10,
          },
        ],
      },
    });

    await agent.run(
      { messages: [{ role: "user", content: "run dangerous command" }] },
      {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (result) => {
          observedToolResult = result;
        },
        onSnapshot: () => undefined,
      },
    );

    expect(executor).toHaveBeenCalledTimes(0);
    expect(observedToolResult?.isError).toBe(true);
    expect(String(observedToolResult?.output)).toContain("input_rule_deny");
  });

  it("require_approval blocks tool execution in run() when no approval flow exists", async () => {
    resetMocks();
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      };
    });

    let observedToolResult: Tool.Result | undefined;
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const call = createToolCall("call-approval", "bash", { command: "ls" });
      const result = await executeTool(input, call);
      sink.onToolCall(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      tools: [
        {
          name: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      toolExecutor: executor,
      permissions: {
        action: "tool.call",
        requireApproval: ["bash"],
      },
    });

    await agent.run(
      { messages: [{ role: "user", content: "run command with approval" }] },
      {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (result) => {
          observedToolResult = result;
        },
        onSnapshot: () => undefined,
      },
    );

    expect(executor).toHaveBeenCalledTimes(0);
    expect(observedToolResult?.isError).toBe(true);
    expect(String(observedToolResult?.output)).toContain("require_approval");
  });

  it("allow delegates to original toolExecutor", async () => {
    resetMocks();
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: `executed:${call.tool}`,
        isError: false,
      };
    });

    let observedToolResult: Tool.Result | undefined;
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const call = createToolCall("call-allow", "bash", { command: "ls" });
      const result = await executeTool(input, call);
      sink.onToolCall(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      tools: [
        {
          name: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      toolExecutor: executor,
      permissions: {
        action: "tool.call",
        allowlist: ["bash"],
      },
    });

    await agent.run(
      { messages: [{ role: "user", content: "safe command" }] },
      {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (result) => {
          observedToolResult = result;
        },
        onSnapshot: () => undefined,
      },
    );

    expect(executor).toHaveBeenCalledTimes(1);
    expect(observedToolResult?.isError).toBe(false);
    expect(observedToolResult?.output).toBe("executed:bash");
  });

  it("without permissions uses original executor for backward compatibility", async () => {
    resetMocks();
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      };
    });

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const call = createToolCall("call-backward", "bash", { command: "rm -rf /" });
      const result = await executeTool(input, call);
      sink.onToolCall(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      tools: [
        {
          name: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      toolExecutor: executor,
    });

    await agent.run({ messages: [{ role: "user", content: "dangerous command" }] });

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("deny also blocks tool execution in stream() path", async () => {
    resetMocks();
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      };
    });

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const call = createToolCall("call-stream-deny", "bash", { command: "rm -rf /" });
      const result = await executeTool(input, call);
      sink.onToolCall(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      tools: [
        {
          name: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      toolExecutor: executor,
      permissions: {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "rm\\s+-rf",
            action: "deny",
            priority: 10,
          },
        ],
      },
    });

    const events = [] as Array<{ type: string; result?: Tool.Result }>;
    for await (const event of agent.stream({ messages: [{ role: "user", content: "stream" }] })) {
      if (event.type === "tool_call_complete") {
        events.push({ type: event.type, result: event.result });
      } else {
        events.push({ type: event.type });
      }
    }

    const toolResultEvent = events.find((event) => event.type === "tool_call_complete");
    expect(executor).toHaveBeenCalledTimes(0);
    expect(toolResultEvent?.result?.isError).toBe(true);
    expect(String(toolResultEvent?.result?.output)).toContain("input_rule_deny");
  });
});
