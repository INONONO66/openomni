import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";
import { Auth } from "../src/auth/storage";

const TEST_PROVIDER_ID = "__test_tool_schema__";
let capturedArgs: Record<string, unknown> | undefined;
let capturedToolConfigs: Record<string, unknown>[] = [];

mock.module("ai", () => ({
  streamText: (args: Record<string, unknown>) => {
    capturedArgs = args;
    return {
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    };
  },
  jsonSchema: (schema: unknown) => ({ __jsonSchema: schema }),
  tool: (config: Record<string, unknown>) => {
    capturedToolConfigs.push(config);
    return { __tool: config };
  },
}));

let run: typeof import("../src/run").run;

beforeAll(async () => {
  await Auth.set(TEST_PROVIDER_ID, { type: "api", key: "test-key-unit" });
  ({ run } = await import("../src/run"));
});

afterAll(async () => {
  await Auth.remove(TEST_PROVIDER_ID);
  mock.restore();
});

describe("run() with model - tool schema conversion", () => {
  const mockSink: Sink = {
    onMessage: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onSnapshot: () => {},
  };

  test("maps Tool.Spec inputSchema to tool() parameters via jsonSchema", async () => {
    capturedArgs = undefined;
    capturedToolConfigs = [];

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
      },
      mockSink,
    );

    expect(capturedArgs).toBeDefined();
    const tools = (capturedArgs as { tools?: Record<string, unknown> } | undefined)?.tools;
    expect(tools).toBeDefined();
    expect(tools!.test_tool).toBeDefined();
    expect(capturedToolConfigs.length).toBe(2);
    const testToolConfig = capturedToolConfigs.find((cfg) => cfg.description === "A test tool");
    expect(testToolConfig).toBeDefined();
    expect(testToolConfig!.parameters).toEqual({
      __jsonSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    expect(testToolConfig!.execute).toBeUndefined();
    expect(testToolConfig!.inputSchema).toBeUndefined();

    const invalidToolConfig = capturedToolConfigs.find(
      (cfg) => cfg.description === "Error handler for unrecognized tool calls",
    );
    expect(invalidToolConfig).toBeDefined();
    expect(invalidToolConfig!.execute).toBeFunction();
  });
});
