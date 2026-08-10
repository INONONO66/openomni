import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";
import type { Provider } from "../src/provider";

let run: typeof import("../src/run").run;

type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: Record<string, unknown>) => {
      aiCapture.__openomniAiStreamArgs = args;
      return {
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      };
    },
    jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
    stepCountIs: (stepCount: number) => {
      return (input: { steps: unknown[] }) => input.steps.length === stepCount;
    },
  }));
}

mockAiModule();

const testModel: Provider.Model = {
  id: "claude-3-haiku",
  providerID: "__test_run_tool_execution__",
  name: "Claude 3 Haiku Test",
  api: { npm: "@ai-sdk/anthropic" },
};

describe("run() tool execution ownership", () => {
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];

  const mockSink: Sink = {
    onMessage: () => undefined,
    onToolCall: (call) => {
      capturedToolCalls.push(call);
    },
    onToolResult: (result) => {
      capturedToolResults.push(result);
    },
  };

  beforeAll(async () => {
    ({ run } = await import("../src/run"));
  });

  beforeEach(() => {
    mockAiModule();
    capturedToolCalls = [];
    capturedToolResults = [];
    aiCapture.__openomniAiStreamArgs = undefined;
  });

  test("does not project tool sink events from AI SDK execute callbacks", async () => {
    const toolExecutor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: "result-1",
        toolCallId: call.id,
        output: "tool-output",
      };
    });

    await run(
      {
        messages: [],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        model: testModel,
        auth: { type: "api", key: "test-key-run-tool" },
        toolExecutor,
      },
      mockSink,
    );

    const streamArgs = aiCapture.__openomniAiStreamArgs;
    const tools = streamArgs?.tools as Record<
      string,
      {
        execute?: (
          args: Record<string, unknown>,
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ) => Promise<{ output: string; isError?: boolean }>;
      }
    >;
    expect(tools.test_tool).toBeDefined();
    const output = await tools.test_tool?.execute?.(
      { query: "value" },
      { toolCallId: "call-from-sdk" },
    );

    expect(output).toEqual({ output: "tool-output" });
    expect(toolExecutor).toHaveBeenCalledWith(
      { id: "call-from-sdk", tool: "test_tool", input: { query: "value" } },
      { signal: expect.any(AbortSignal) },
    );
    expect(capturedToolCalls).toEqual([]);
    expect(capturedToolResults).toEqual([]);
  });

  test("preserves tool execution error state for AI SDK tool results", async () => {
    const toolExecutor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return {
        id: "result-error",
        toolCallId: call.id,
        output: "tool-error",
        isError: true,
      };
    });

    await run(
      {
        messages: [],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        model: testModel,
        auth: { type: "api", key: "test-key-run-tool" },
        toolExecutor,
      },
      mockSink,
    );

    const streamArgs = aiCapture.__openomniAiStreamArgs;
    const tools = streamArgs?.tools as Record<
      string,
      {
        execute?: (
          args: Record<string, unknown>,
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ) => Promise<{ output: string; isError?: boolean }>;
      }
    >;
    expect(tools.test_tool).toBeDefined();
    const output = await tools.test_tool?.execute?.(
      { query: "value" },
      { toolCallId: "call-from-sdk" },
    );

    expect(output).toEqual({ output: "tool-error", isError: true });
  });

  test("normalizes missing tool execution results to structured output", async () => {
    const toolExecutor = mock(
      async (): Promise<Tool.Result> => undefined as unknown as Tool.Result,
    );

    await run(
      {
        messages: [],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        model: testModel,
        auth: { type: "api", key: "test-key-run-tool" },
        toolExecutor,
      },
      mockSink,
    );

    const streamArgs = aiCapture.__openomniAiStreamArgs;
    const tools = streamArgs?.tools as Record<
      string,
      {
        execute?: (
          args: Record<string, unknown>,
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ) => Promise<{ output: string; isError?: boolean }>;
      }
    >;
    const output = await tools.test_tool?.execute?.({});

    expect(output).toEqual({ output: "" });
  });
});
