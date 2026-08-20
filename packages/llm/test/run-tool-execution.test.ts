import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { Sink } from "../src/sink";
import type { Provider } from "../src/provider";
import { Bus, newTraceId } from "@openomni/telemetry";

const TEST_TRACE = { traceId: newTraceId(), sessionId: "session-test", runId: "run-test" };

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
        trace: TEST_TRACE,
        events: Bus,
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
        trace: TEST_TRACE,
        events: Bus,
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

  test("SDK invoking the sanitized wire key routes the dotted internal name to the executor", async () => {
    const toolExecutor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      return { id: "result-1", toolCallId: call.id, output: "sent" };
    });

    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        tools: [
          {
            name: "message.send",
            description: "the native dotted tool",
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
      { execute?: (a: Record<string, unknown>, o?: { toolCallId?: string }) => Promise<unknown> }
    >;
    // The SDK sees only the wire key; the dotted name would be rejected.
    expect(tools.message_send).toBeDefined();
    expect(tools["message.send"]).toBeUndefined();

    await tools.message_send?.execute?.({ text: "hi" }, { toolCallId: "call-1" });

    // The execute closure restores the dotted internal name for execution/policy.
    expect(toolExecutor).toHaveBeenCalledWith(
      { id: "call-1", tool: "message.send", input: { text: "hi" } },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("distinct MCP originals that sanitize to one key get distinct reachable wire names", async () => {
    const seen: string[] = [];
    const toolExecutor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      seen.push(call.tool);
      return { id: `r-${call.id}`, toolCallId: call.id, output: "ok" };
    });

    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        // Two distinct arbitrary MCP names both sanitize to "srv_x_y".
        tools: [
          { name: "srv.x.y", description: "a", inputSchema: { type: "object" } },
          { name: "srv_x_y", description: "b", inputSchema: { type: "object" } },
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
      { execute?: (a: Record<string, unknown>, o?: { toolCallId?: string }) => Promise<unknown> }
    >;
    const keys = Object.keys(tools);
    // No silent overwrite: two keys, one disambiguated deterministically.
    expect(keys).toEqual(["srv_x_y", "srv_x_y_2"]);

    await tools.srv_x_y?.execute?.({}, { toolCallId: "c1" });
    await tools.srv_x_y_2?.execute?.({}, { toolCallId: "c2" });

    // Both closures are reachable and each routes to its own dotted original.
    expect(seen).toEqual(["srv.x.y", "srv_x_y"]);
  });

  test("normalizes missing tool execution results to structured output", async () => {
    const toolExecutor = mock(
      async (): Promise<Tool.Result> => undefined as unknown as Tool.Result,
    );

    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
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
    const output = await tools.test_tool?.execute?.({}, { toolCallId: "call-missing-result" });

    expect(output).toEqual({ output: "" });
    // Pin (#606 audit): a minted id can never correlate with the stream's
    // tool part — execute without the SDK-supplied toolCallId refuses.
    await expect(tools.test_tool?.execute?.({})).rejects.toThrow(
      "tool execute called without toolCallId",
    );
  });
});
