import { describe, expect, test, beforeEach } from "bun:test";
import { run, type RunInput } from "../src/run";
import type { Sink, Message, Tool, Run } from "@openomni/protocol";

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];
  let capturedSnapshots: Run.Snapshot[];

  beforeEach(() => {
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedSnapshots = [];

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
    const input: RunInput = {
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
    const input: RunInput = {
      messages: [],
      tools: [],
      system: "test system prompt",
      signal: abortController.signal,
    };

    expect(input.system).toBe("test system prompt");
    expect(input.signal).toBe(abortController.signal);
  });

  test("returns RunOutcome with stop type", async () => {
    const input: RunInput = {
      messages: [],
      tools: [],
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("stop");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("handles abort signal", async () => {
    const abortController = new AbortController();
    const input: RunInput = {
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
    const input: RunInput = {
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

    const input: RunInput = {
      messages: [],
      tools: [],
      signal: controller.signal,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("calls sink methods during execution", async () => {
    const input: RunInput = {
      messages: [],
      tools: [],
    };

    await run(input, mockSink);

    expect(capturedSnapshots.length).toBeGreaterThan(0);
    expect(capturedToolCalls.length).toBe(0);
  });
});
