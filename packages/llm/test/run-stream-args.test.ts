import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { Bus, collector, newTraceId } from "@openomni/telemetry";
import { Operational } from "@openomni/protocol";

const TEST_TRACE = { traceId: newTraceId(), sessionId: "session-test", runId: "run-test" };

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
        trace: TEST_TRACE,
        events: Bus,
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
        trace: TEST_TRACE,
        events: Bus,
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

  /**
   * `streamText`'s `onError` is the one publish site the happy and failure
   * paths both miss, so it was free to route back to a global bus.
   */
  test("reports a stream error through the injected sink", async () => {
    const collected = collector();
    const busSaw: string[] = [];
    const unsubscribe = Bus.observe((descriptor) => busSaw.push(descriptor.name));

    try {
      await run(
        {
          trace: TEST_TRACE,
          events: collected,
          messages: [],
          tools: [],
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
      const onError = aiCapture.__openomniAiStreamArgs?.onError as
        | ((payload: { error: unknown }) => void)
        | undefined;
      if (onError === undefined) throw new Error("streamText received no onError");
      onError({ error: new Error("upstream exploded") });
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    const errors = collected
      .named(Operational.Error.name)
      .map((event) => event as { component?: string; error?: string });
    const fromStream = errors.filter((event) => event.component === "llm.stream");
    expect(fromStream).toHaveLength(1);
    expect(fromStream[0]?.error).toContain("upstream exploded");
    expect(busSaw).toEqual([]);
  });
});
