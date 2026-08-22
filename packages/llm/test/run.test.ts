import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmCall, type Message, type Tool } from "@openomni/protocol";
import type { Sink } from "../src/sink";
import { Bus, collector } from "@openomni/telemetry";
import { Auth } from "../src/auth";
import type { Provider } from "../src/provider";
import { newTraceId } from "@openomni/telemetry";

const TEST_TRACE = { traceId: newTraceId(), sessionId: "session-test", runId: "run-test" };

let run: typeof import("../src/run").run;

type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

type StreamChunk = { type: string; [key: string]: unknown };

let mockStreamChunks: StreamChunk[] = [{ type: "finish" }];

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: Record<string, unknown>) => {
      aiCapture.__openomniAiStreamArgs = args;
      const chunks = mockStreamChunks;
      return {
        fullStream: (async function* () {
          yield* chunks;
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

const testAuth = { type: "api", key: "test-key-run" } as const;
const testModel: Provider.Model = {
  id: "claude-3-haiku",
  providerID: "__test_run__",
  name: "Claude 3 Haiku Test",
  api: { npm: "@ai-sdk/anthropic" },
};

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];

  beforeAll(async () => {
    ({ run } = await import("../src/run"));
  });

  beforeEach(() => {
    mockStreamChunks = [{ type: "finish" }];
    mockAiModule();
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    aiCapture.__openomniAiStreamArgs = undefined;

    mockSink = {
      onMessage: (message: Message.WithParts) => {
        capturedMessages.push(message);
      },
      onToolCall: (call: Tool.Call) => {
        capturedToolCalls.push(call);
      },
      onToolResult: (result: Tool.Result) => {
        capturedToolResults.push(result);
      },
    };
  });

  afterEach(() => {
    aiCapture.__openomniAiStreamArgs = undefined;
  });

  test("returns RunOutcome with stop type", async () => {
    const input: import("../src/run").RunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("stop");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("handles abort signal", async () => {
    const abortController = new AbortController();
    const input: import("../src/run").RunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
      signal: abortController.signal,
    };

    abortController.abort();

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("returns error outcome when auth is not configured", async () => {
    const input: import("../src/run").RunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: {
        id: "claude-3-haiku",
        providerID: "no-auth-provider-xyz",
        name: "Test Model",
        api: { npm: "@ai-sdk/anthropic" },
      },
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("error");
    if (outcome.type === "error") {
      expect(outcome.error.message).toContain("no-auth-provider-xyz");
    }
    expect(capturedToolCalls.length).toBe(0);
  });

  test("preserves typed terminal provider facts in the error outcome", async () => {
    const source = Object.assign(new Error("opaque provider failure"), {
      isRetryable: false,
      statusCode: 400,
      responseHeaders: { "retry-after-ms": "1234" },
      contextOverflow: true,
    });
    mock.module("ai", () => ({
      streamText: () => ({
        fullStream: (async function* () {
          yield {
            type: "finish-step",
            finishReason: "error",
            usage: { inputTokens: 17, outputTokens: 5 },
          };
          yield { type: "error", error: source };
        })(),
      }),
      jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
      stepCountIs: () => () => false,
    }));

    const outcome = await run(
      { trace: TEST_TRACE, events: Bus, messages: [], tools: [], model: testModel, auth: testAuth },
      mockSink,
    );

    expect(outcome.type).toBe("error");
    if (outcome.type !== "error" || !(outcome.error instanceof Error)) {
      throw new Error("expected a typed failure");
    }
    const failure = outcome.error as InstanceType<typeof import("../src/run").Run.FailureError>;
    expect(failure.data).toMatchObject({
      retryAfterMs: 1_234,
      usage: { inputTokens: 17, outputTokens: 5 },
      aborted: false,
      contextOverflow: true,
    });
    expect((failure.cause as Error).cause).toBe(source);
  });

  test("preserves a provider abort fact in the aborted outcome", async () => {
    const source = Object.assign(new Error("provider cancelled"), {
      isRetryable: false,
      aborted: true,
    });
    mock.module("ai", () => ({
      streamText: () => ({
        fullStream: (async function* () {
          yield { type: "error", error: source };
        })(),
      }),
      jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
      stepCountIs: () => () => false,
    }));

    const outcome = await run(
      { trace: TEST_TRACE, events: Bus, messages: [], tools: [], model: testModel, auth: testAuth },
      mockSink,
    );

    expect(outcome.type).toBe("aborted");
    if (outcome.type !== "aborted") throw new Error("expected an aborted outcome");
    expect(outcome.error?.data.aborted).toBe(true);
    expect((outcome.error?.cause as Error).cause).toBe(source);
  });

  test("publishes LlmCall.Events.Failed on error so every Started call terminates", async () => {
    const failures: Array<{ readonly error: string; readonly traceId: string }> = [];
    const unsub = Bus.subscribe(LlmCall.Events.Failed, (event) => {
      failures.push(event);
    });

    const outcome = await run(
      {
        messages: [],
        tools: [],
        model: {
          id: "claude-3-haiku",
          providerID: "no-auth-provider-failed-event",
          name: "Test Model",
          api: { npm: "@ai-sdk/anthropic" },
        },
        trace: { traceId: "trace-run-failed", sessionId: "session-failed", runId: "run-failed" },
        events: Bus,
      },
      mockSink,
    );
    unsub();

    expect(outcome.type).toBe("error");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      traceId: "trace-run-failed",
      aborted: false,
    });
    expect(failures[0]?.error).toContain("no-auth-provider-failed-event");
  });

  test("does not read stored auth when fallback is disabled", async () => {
    const authFile = join(tmpdir(), `openomni-run-auth-${crypto.randomUUID()}.json`);

    try {
      await Auth.withFile(authFile, async () => {
        await Auth.set("stored-auth-provider", testAuth);

        const outcome = await run(
          {
            trace: TEST_TRACE,
            events: Bus,
            messages: [],
            tools: [],
            allowAuthFallback: false,
            model: {
              id: "claude-3-haiku",
              providerID: "stored-auth-provider",
              name: "Test Model",
              api: { npm: "@ai-sdk/anthropic" },
            },
          },
          mockSink,
        );

        expect(outcome.type).toBe("error");
        expect(aiCapture.__openomniAiStreamArgs).toBeUndefined();
      });
    } finally {
      rmSync(authFile, { force: true });
    }
  });

  test("returns aborted outcome when signal is aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    const input: import("../src/run").RunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
      signal: controller.signal,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
    expect(aiCapture.__openomniAiStreamArgs).toBeUndefined();
  });

  test("calls sink methods during execution", async () => {
    const input: import("../src/run").RunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
    };

    await run(input, mockSink);

    expect(capturedMessages.length).toBeGreaterThan(0);
    expect(capturedToolCalls.length).toBe(0);
  });

  test("v6 text block yields exactly one non-empty text part (no v4 shim duplicates)", async () => {
    // Real ai-sdk v6 fullStream shape: explicit text-start/text-end frame the deltas.
    // The removed v4 shim synthesized a second text-start on the first delta,
    // leaving an orphan empty text part per block — this asserts that never returns.
    mockStreamChunks = [
      { type: "start-step" },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", text: "hello " },
      { type: "text-delta", id: "txt_1", text: "world" },
      { type: "text-end", id: "txt_1" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    mockAiModule();

    const outcome = await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        tools: [],
        model: testModel,
        auth: testAuth,
      },
      mockSink,
    );

    expect(outcome.type).toBe("stop");
    const lastMessage = capturedMessages.at(-1);
    expect(lastMessage).toBeDefined();
    const textParts = (lastMessage?.parts ?? []).filter((part) => part.type === "text");
    expect(textParts.length).toBe(1);
    expect(textParts[0]?.text).toBe("hello world");
    expect(textParts.some((part) => part.text === "")).toBe(false);
  });

  test("LlmCall.Events.Completed reports usage summed across retried attempts", async () => {
    // Regression (#audit M3): Completed read processor.message.tokens — the
    // final attempt's fold — so a retried attempt's billed usage vanished
    // from telemetry.
    let call = 0;
    mock.module("ai", () => ({
      streamText: () => {
        call++;
        const chunks: StreamChunk[] =
          call === 1
            ? [
                {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 100, outputTokens: 40 },
                },
                {
                  type: "error",
                  error: Object.assign(new Error("overloaded"), {
                    isRetryable: true,
                    statusCode: 529,
                    responseHeaders: { "retry-after-ms": "1" },
                  }),
                },
              ]
            : [
                {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 200, outputTokens: 60 },
                },
                { type: "finish" },
              ];
        return {
          fullStream: (async function* () {
            yield* chunks;
          })(),
        };
      },
      jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
      stepCountIs: () => () => false,
    }));

    const collected = collector();
    const outcome = await run(
      {
        trace: TEST_TRACE,
        events: collected,
        messages: [],
        tools: [],
        model: testModel,
        auth: testAuth,
      },
      mockSink,
    );

    expect(outcome.type).toBe("stop");
    expect(call).toBe(2);
    const completed = collected.named(LlmCall.Events.Completed.name) as Array<{
      inputTokens: number;
      outputTokens: number;
    }>;
    expect(completed).toHaveLength(1);
    expect(completed[0]?.inputTokens).toBe(300);
    expect(completed[0]?.outputTokens).toBe(100);
  });

  /**
   * The point of the port. `llm` reports what it did to whatever the caller
   * hands it — no process-wide `Bus`, nothing to reset between tests, and P2
   * can put a fail-closed ledger append behind this without touching `run()`.
   */
  test("reports through the injected sink, not a global bus", async () => {
    const collected = collector();
    const busSaw: string[] = [];
    const unsubscribe = Bus.observe((descriptor) => busSaw.push(descriptor.name));

    try {
      await run(
        {
          messages: [],
          tools: [],
          model: testModel,
          auth: testAuth,
          trace: TEST_TRACE,
          events: collected,
        },
        mockSink,
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(collected.named(LlmCall.Events.Started.name)).toHaveLength(1);
    // Every `Started` gets a terminal event — the success half of the pair the
    // failure test covers.
    expect(collected.named(LlmCall.Events.Completed.name)).toHaveLength(1);
    // Not filtered to `llm.*`: an `operational.*` record routed back through
    // the global bus is the same defect, and the filter hid six of the eight
    // publish sites from this assertion.
    expect(busSaw).toEqual([]);
  });

  /**
   * The failure path publishes three of the eight records, and the happy path
   * never reaches it — so without this the port is unpinned there.
   */
  test("reports a failed call through the injected sink too", async () => {
    const collected = collector();
    const busSaw: string[] = [];
    const unsubscribe = Bus.observe((descriptor) => busSaw.push(descriptor.name));

    try {
      const outcome = await run(
        {
          messages: [],
          tools: [],
          model: {
            id: "claude-3-haiku",
            providerID: "no-auth-provider-port-test",
            name: "Test Model",
            api: { npm: "@ai-sdk/anthropic" },
          },
          trace: TEST_TRACE,
          events: collected,
        },
        mockSink,
      );
      expect(outcome.type).toBe("error");
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(collected.named(LlmCall.Events.Started.name)).toHaveLength(1);
    expect(collected.named(LlmCall.Events.Failed.name)).toHaveLength(1);
    expect(busSaw).toEqual([]);
  });

  /**
   * Refused at the boundary rather than half-dropped: an empty trace used to
   * silence the processor's records while `run` kept publishing malformed
   * ones, which displaces the wrong-kind defect instead of closing it.
   */
  test.each([
    ["traceId", { traceId: "", sessionId: "s", runId: "r" }],
    ["sessionId", { traceId: "t", sessionId: "", runId: "r" }],
    // The docstring always claimed a call "that cannot name its run" is
    // refused; the guard only checked traceId/sessionId, so an empty runId
    // sailed through into every LlmCall event (#606 re-audit).
    ["runId", { traceId: "t", sessionId: "s", runId: "" }],
  ])("refuses an empty %s", async (_field, trace) => {
    await expect(
      run(
        { messages: [], tools: [], model: testModel, auth: testAuth, trace, events: collector() },
        mockSink,
      ),
    ).rejects.toThrow("llm run requires a non-empty traceId, sessionId, and runId");
  });
});
