import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";
import { Auth } from "../src/auth/storage";

const TEST_PROVIDER_ID = "__test_tool_schema__";
let capturedArgs: Record<string, unknown> | undefined;

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

  test("maps Tool.Spec inputSchema to SDK parameters property", async () => {
    capturedArgs = undefined;

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
    const sdkTool = tools!["test_tool"] as Record<string, unknown>;
    expect(sdkTool["parameters"]).toBeDefined();
    expect(sdkTool["inputSchema"]).toBeUndefined();
  });
});
