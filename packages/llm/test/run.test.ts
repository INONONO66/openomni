import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { Auth } from "../src/auth/storage";

const TEST_PROVIDER_ID = "__test_run__";
let run: typeof import("../src/run").run;

let capturedStreamArgs: Record<string, unknown> | undefined;

mock.module("ai", () => ({
  streamText: (args: Record<string, unknown>) => {
    capturedStreamArgs = args;
    return {
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    };
  },
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
}));

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];
  let capturedSnapshots: Run.Snapshot[];

  beforeAll(async () => {
    await Auth.set(TEST_PROVIDER_ID, { type: "api", key: "test-key-run" });
    ({ run } = await import("../src/run"));
  });

  afterAll(async () => {
    await Auth.remove(TEST_PROVIDER_ID);
    mock.restore();
  });

  beforeEach(() => {
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedSnapshots = [];
    capturedStreamArgs = undefined;

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
      model: {
        id: "claude-3-haiku",
        providerID: TEST_PROVIDER_ID,
        name: "Claude 3 Haiku Test",
        api: { npm: "@ai-sdk/anthropic" },
      },
    };

    await run(input, mockSink);

    expect(capturedStreamArgs).toBeDefined();
    expect(capturedStreamArgs!["toolChoice"]).toBe("required");
    expect(capturedStreamArgs!["stopWhen"]).toBeFunction();
    expect(capturedStreamArgs!["maxRetries"]).toBe(0);

    const stopWhen = capturedStreamArgs!["stopWhen"] as (input: { steps: unknown[] }) => boolean;
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
    };

    await run(input, mockSink);

    expect(capturedStreamArgs).toBeDefined();
    expect(capturedStreamArgs!["stopWhen"]).toBeFunction();

    const stopWhen = capturedStreamArgs!["stopWhen"] as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 23 }) })).toBe(false);
    expect(stopWhen({ steps: Array.from({ length: 24 }) })).toBe(true);
  });
});
