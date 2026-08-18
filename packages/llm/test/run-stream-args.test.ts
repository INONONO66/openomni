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
    expect(streamArgs.maxRetries).toBe(0);
    expect(aiCapture.__openomniAiStepCount).toBe(7);

    // stopWhen is a condition list since the window yield joined the cap.
    const conditions = streamArgs.stopWhen as Array<(input: { steps: unknown[] }) => boolean>;
    expect(conditions).toBeArrayOfSize(1);
    const stepCap = conditions[0] as (input: { steps: unknown[] }) => boolean;
    expect(stepCap({ steps: [] })).toBe(false);
    expect(stepCap({ steps: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(stepCap({ steps: [1, 2, 3, 4, 5, 6, 7] })).toBe(true);
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
    expect(aiCapture.__openomniAiStepCount).toBe(24);

    const conditions = streamArgs.stopWhen as Array<(input: { steps: unknown[] }) => boolean>;
    expect(conditions).toBeArrayOfSize(1);
    const stepCap = conditions[0] as (input: { steps: unknown[] }) => boolean;
    expect(stepCap({ steps: Array.from({ length: 23 }) })).toBe(false);
    expect(stepCap({ steps: Array.from({ length: 24 }) })).toBe(true);
  });

  test("arms a window-yield condition only when yieldAtInputTokens is set", async () => {
    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        tools: [],
        maxSteps: 24,
        yieldAtInputTokens: 800,
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

    const streamArgs = aiCapture.__openomniAiStreamArgs as { stopWhen?: unknown };
    const conditions = streamArgs.stopWhen as Array<
      (input: { steps: Array<{ usage?: { inputTokens?: number } }> }) => boolean
    >;
    expect(conditions).toBeArrayOfSize(2);
    const windowYield = conditions[1] as (input: {
      steps: Array<{ usage?: { inputTokens?: number } }>;
    }) => boolean;
    // Reads the LAST step's cache-inclusive input — not a sum across steps.
    expect(windowYield({ steps: [{ usage: { inputTokens: 900 } }] })).toBe(true);
    expect(windowYield({ steps: [{ usage: { inputTokens: 799 } }] })).toBe(false);
    // Boundary pin (#606 audit M1): the threshold itself yields — AT the
    // window is at the window; a `>` drift here silently defers compaction
    // by one step on every exact hit.
    expect(windowYield({ steps: [{ usage: { inputTokens: 800 } }] })).toBe(true);
    expect(
      windowYield({ steps: [{ usage: { inputTokens: 900 } }, { usage: { inputTokens: 700 } }] }),
    ).toBe(false);
    expect(windowYield({ steps: [{}] })).toBe(false);
    expect(windowYield({ steps: [] })).toBe(false);
  });

  test("passes providerOptions as the nested streamText key, never a top-level spread", async () => {
    // Regression (#audit M1): providerOptions used to be spread into the
    // top-level streamText args. The AI SDK reads provider namespaces from
    // the nested `providerOptions` key, so operator config like
    // {anthropic:{thinking:...}} was silently ignored — and config keys
    // could clobber wired args (abortSignal, maxRetries, tools).
    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        tools: [{ name: "lookup", description: "look", inputSchema: { type: "object" } }],
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
          // Keys that would clobber wired args under the old top-level spread:
          abortSignal: "clobbered",
          maxRetries: 99,
          tools: "clobbered",
        },
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

    const streamArgs = aiCapture.__openomniAiStreamArgs as {
      providerOptions?: Record<string, unknown>;
      abortSignal?: unknown;
      maxRetries?: unknown;
      tools?: Record<string, unknown>;
    };
    expect(streamArgs.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      abortSignal: "clobbered",
      maxRetries: 99,
      tools: "clobbered",
    });
    // Wired args survive untouched.
    expect(streamArgs.maxRetries).toBe(0);
    expect(streamArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(streamArgs.tools ?? {})).toEqual(["lookup"]);
  });

  test("omits the providerOptions key entirely when none are configured", async () => {
    await run(
      {
        trace: TEST_TRACE,
        events: Bus,
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

    const streamArgs = aiCapture.__openomniAiStreamArgs as Record<string, unknown>;
    expect("providerOptions" in streamArgs).toBe(false);
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
      .named(Operational.Events.Error.name)
      .map((event) => event as { component?: string; error?: string });
    const fromStream = errors.filter((event) => event.component === "llm.stream");
    expect(fromStream).toHaveLength(1);
    expect(fromStream[0]?.error).toContain("upstream exploded");
    expect(busSaw).toEqual([]);
  });
});
