import { describe, expect, test, beforeEach } from "bun:test";
import { run, type RunInput } from "../src/run";
import type {
  Sink,
  Message,
  ToolCall,
  ToolResult,
  RunSnapshot,
} from "@openomni/protocol";

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: ToolCall[];
  let capturedToolResults: ToolResult[];
  let capturedSnapshots: RunSnapshot[];

  beforeEach(() => {
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedSnapshots = [];

    mockSink = {
      onMessage: (message: Message.WithParts) => {
        capturedMessages.push(message);
      },
      onToolCall: (call: ToolCall) => {
        capturedToolCalls.push(call);
      },
      onToolResult: (result: ToolResult) => {
        capturedToolResults.push(result);
      },
      onSnapshot: (snapshot: RunSnapshot) => {
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
  });

  test("calls sink methods during execution", async () => {
    const input: RunInput = {
      messages: [],
      tools: [],
    };

    await run(input, mockSink);

    expect(capturedSnapshots.length).toBeGreaterThan(0);
  });
});
