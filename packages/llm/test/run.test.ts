import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { Auth } from "../src/auth";
import type { Provider } from "../src/provider";

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
  let capturedSnapshots: Run.Snapshot[];

  beforeAll(async () => {
    ({ run } = await import("../src/run"));
  });

  beforeEach(() => {
    mockStreamChunks = [{ type: "finish" }];
    mockAiModule();
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedSnapshots = [];
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
      onSnapshot: (snapshot: Run.Snapshot) => {
        capturedSnapshots.push(snapshot);
      },
    };
  });

  afterEach(() => {
    aiCapture.__openomniAiStreamArgs = undefined;
  });

  test("returns RunOutcome with stop type", async () => {
    const input: import("../src/run").RunInput = {
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

  test("does not read stored auth when fallback is disabled", async () => {
    const authFile = join(tmpdir(), `openomni-run-auth-${crypto.randomUUID()}.json`);

    try {
      await Auth.withFile(authFile, async () => {
        await Auth.set("stored-auth-provider", testAuth);

        const outcome = await run(
          {
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
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
    };

    await run(input, mockSink);

    expect(capturedSnapshots.length).toBeGreaterThan(0);
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
      { messages: [], tools: [], model: testModel, auth: testAuth },
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
});
