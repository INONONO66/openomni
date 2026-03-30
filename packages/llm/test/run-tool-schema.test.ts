// @ts-nocheck
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";

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

mock.module(new URL("../src/auth/storage.ts", import.meta.url).pathname, () => ({
  Auth: {
    get: async () => ({ type: "api", key: "test-key" }),
  },
}));

mock.module(new URL("../src/provider/index.ts", import.meta.url).pathname, () => ({
  getLanguage: () => ({ modelId: "claude-3-haiku", specificationVersion: "v1" }),
}));

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

afterAll(() => {
  mock.restore();
});

describe("run() with model - tool schema conversion", () => {
  const mockSink: Sink = {
    onMessage: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onSnapshot: () => {},
  };

  test("maps Tool.Spec inputSchema to SDK parameters", async () => {
    capturedArgs = undefined;

    const outcome = await run(
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
          providerID: "anthropic",
          name: "Claude 3 Haiku",
          api: { npm: "@ai-sdk/anthropic" },
        },
      },
      mockSink,
    );

    expect(outcome.type).toBe("stop");
    expect(capturedArgs).toBeDefined();

    const tools = (capturedArgs as { tools?: Record<string, unknown> } | undefined)?.tools;
    expect(tools).toBeDefined();

    const sdkTool = tools!["test_tool"] as Record<string, unknown>;
    expect(sdkTool).toBeDefined();
    expect(sdkTool["parameters"]).toBeDefined();
    expect(sdkTool["inputSchema"]).toBeUndefined();
  });
});
