import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { newTraceId } from "@openomni/telemetry";

const TEST_TRACE_ID = newTraceId();

const TEST_PROVIDER_ID = "__test_run_stream_args__";

type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
  __openomniAiStepCount?: number;
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
      aiCapture.__openomniAiStepCount = stepCount;
      return (input: { steps: unknown[] }) => input.steps.length === stepCount;
    },
  }));
}

mockAiModule();

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

describe("run() streamText arguments", () => {
  const mockSink: Sink = {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };

  beforeEach(() => {
    mockAiModule();
    aiCapture.__openomniAiStreamArgs = undefined;
    aiCapture.__openomniAiStepCount = undefined;
  });

  test("forwards toolChoice and AI SDK stepCountIs stopWhen, and sets maxRetries to 0", async () => {
    await run(
      {
        trace: { traceId: TEST_TRACE_ID },
        messages: [],
        tools: [],
        toolChoice: "required",
        maxSteps: 7,
        auth: { type: "api", key: "test-key-run" },
        model: {
          id: "claude-3-haiku",
          providerID: TEST_PROVIDER_ID,
          name: "Claude 3 Haiku Test",
          api: { npm: "@ai-sdk/anthropic" },
        },
      },
      mockSink,
    );

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as {
      toolChoice?: unknown;
      stopWhen?: unknown;
      maxRetries?: unknown;
    };

    expect(streamArgs.toolChoice).toBe("required");
    expect(streamArgs.stopWhen).toBeFunction();
    expect(streamArgs.maxRetries).toBe(0);
    expect(aiCapture.__openomniAiStepCount).toBe(7);

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [] })).toBe(false);
    expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6, 7] })).toBe(true);
  });

  test("uses default stepCountIs threshold when maxSteps is not provided", async () => {
    await run(
      {
        trace: { traceId: TEST_TRACE_ID },
        messages: [],
        tools: [],
        model: {
          id: "claude-3-haiku",
          providerID: TEST_PROVIDER_ID,
          name: "Claude 3 Haiku Test",
          api: { npm: "@ai-sdk/anthropic" },
        },
        auth: { type: "api", key: "test-key-run" },
      },
      mockSink,
    );

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as { stopWhen?: unknown };
    expect(streamArgs.stopWhen).toBeFunction();
    expect(aiCapture.__openomniAiStepCount).toBe(24);

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 23 }) })).toBe(false);
    expect(stopWhen({ steps: Array.from({ length: 24 }) })).toBe(true);
  });
});
