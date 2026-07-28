import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";

const TEST_PROVIDER_ID = "__test_tool_schema__";
type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

function getAiStreamArgs(): Record<string, unknown> | undefined {
  return aiCapture.__openomniAiStreamArgs;
}

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

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

describe("run() with model - tool schema conversion", () => {
  const mockSink: Sink = {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onSnapshot: () => undefined,
  };

  test("maps Tool.Spec inputSchema to raw function tools via jsonSchema", async () => {
    mockAiModule();
    aiCapture.__openomniAiStreamArgs = undefined;

    await run(
      {
        messages: [],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: { x: { type: "string" } } },
          },
        ] as Tool.Spec[],
        model: {
          id: "claude-3-haiku",
          providerID: TEST_PROVIDER_ID,
          name: "Claude 3 Haiku Test",
          api: { npm: "@ai-sdk/anthropic" },
        },
        auth: { type: "api", key: "test-key-unit" },
      },
      mockSink,
    );

    const streamArgs = getAiStreamArgs();
    expect(streamArgs).toBeDefined();
    if (!streamArgs) throw new Error("expected stream args");
    const tools = streamArgs.tools as Record<string, unknown> | undefined;
    expect(tools).toBeDefined();
    if (!tools) throw new Error("expected stream tools");
    expect(tools.test_tool).toBeDefined();
    expect(tools.test_tool).toEqual({
      type: "function",
      description: "A test tool",
      inputSchema: { jsonSchema: { type: "object", properties: { x: { type: "string" } } } },
    });
  });
});
