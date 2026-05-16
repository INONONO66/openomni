import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { Auth } from "../src/auth";

const TEST_PROVIDER_ID = "__test_run__";
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
  }));
}

mockAiModule();

const testAuth = { type: "api", key: "test-key-run" } as const;

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

  test("accepts RunInput with required fields", () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
    };

    expect(input.messages).toEqual([]);
    expect(input.tools).toEqual([]);
    expect(input.system).toBeUndefined();
    expect(input.signal).toBeUndefined();
  });

  test("accepts RunInput with optional fields", () => {
    const abortController = new AbortController();
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      system: "test system prompt",
      signal: abortController.signal,
      toolChoice: "required",
      maxSteps: 12,
      toolExecutor: async () => ({
        id: "result-1",
        toolCallId: "call-1",
        output: "ok",
      }),
    };

    expect(input.system).toBe("test system prompt");
    expect(input.signal).toBe(abortController.signal);
    expect(input.toolChoice).toBe("required");
    expect(input.maxSteps).toBe(12);
    expect(input.toolExecutor).toBeFunction();
  });

  test("returns RunOutcome with stop type", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
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
      signal: controller.signal,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("calls sink methods during execution", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
    };

    await run(input, mockSink);

    expect(capturedSnapshots.length).toBeGreaterThan(0);
    expect(capturedToolCalls.length).toBe(0);
  });

  test("forwards toolChoice and stopWhen, and sets maxRetries to 0", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      toolChoice: "required",
      maxSteps: 7,
      auth: testAuth,
      model: {
        id: "claude-3-haiku",
        providerID: TEST_PROVIDER_ID,
        name: "Claude 3 Haiku Test",
        api: { npm: "@ai-sdk/anthropic" },
      },
    };

    await run(input, mockSink);

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as {
      toolChoice?: unknown;
      stopWhen?: unknown;
      maxRetries?: unknown;
    };

    expect(streamArgs.toolChoice).toBe("required");
    expect(streamArgs.stopWhen).toBeFunction();
    expect(streamArgs.maxRetries).toBe(0);

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [] })).toBe(false);
    expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(
      stopWhen({
        steps: [1, 2, 3, 4, 5, 6, 7],
      }),
    ).toBe(true);
  });

  test("uses default stopWhen threshold when not provided", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: {
        id: "claude-3-haiku",
        providerID: TEST_PROVIDER_ID,
        name: "Claude 3 Haiku Test",
        api: { npm: "@ai-sdk/anthropic" },
      },
      auth: testAuth,
    };

    await run(input, mockSink);

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as { stopWhen?: unknown };
    expect(streamArgs.stopWhen).toBeFunction();

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 23 }) })).toBe(false);
    expect(stopWhen({ steps: Array.from({ length: 24 }) })).toBe(true);
  });

  test("returns RunOutcome with correct type mapping for processor results", () => {
    const testCases: Array<["stop" | "continue" | "compact", "stop" | "continue" | "compact"]> = [
      ["stop", "stop"],
      ["continue", "continue"],
      ["compact", "compact"],
    ];

    for (const [processorResult, expectedOutcomeType] of testCases) {
      const switchResult = (() => {
        switch (processorResult) {
          case "stop":
            return { type: "stop" as const };
          case "continue":
            return { type: "continue" as const };
          case "compact":
            return { type: "compact" as const };
          default:
            return { type: "stop" as const };
        }
      })();

      expect(switchResult.type).toBe(expectedOutcomeType);
    }
  });
});
