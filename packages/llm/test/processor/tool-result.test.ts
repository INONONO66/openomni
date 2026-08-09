import { afterEach, describe, expect, test } from "bun:test";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "msg-tool-result",
    sessionID: "session-tool-result",
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-tool-result",
    modelID: "claude-3-5-sonnet",
    providerID: "anthropic",
    agent: "test-agent",
    path: { cwd: "/test", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

const model: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

describe("Processor tool result projection", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("projects AI SDK tool-call and tool-result stream parts once", async () => {
    const toolCalls: Tool.Call[] = [];
    const toolResults: Tool.Result[] = [];
    const snapshots: Run.Snapshot[] = [];
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: (call) => toolCalls.push(call),
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
          };
          await Bun.sleep(10);
          yield {
            type: "tool-result",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
            output: "sunny",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    expect(toolCalls).toEqual([{ id: "call-weather", tool: "weather", input: { city: "Seoul" } }]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-weather",
      output: "sunny",
    });
    expect(snapshots.length).toBeGreaterThan(0);
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      callID: "call-weather",
      tool: "weather",
      state: { status: "completed", output: "sunny" },
    });

    // The tool runs between tool-call and tool-result: start is recorded at
    // the call event, so the part reports a real duration.
    const state = toolPart?.type === "tool" ? toolPart.state : undefined;
    if (state?.status !== "completed") throw new Error("expected completed tool state");
    expect(state.time.end - state.time.start).toBeGreaterThanOrEqual(5);

    const runningSnapshot = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.state.status === "running");
    expect(runningSnapshot).toBeDefined();
  });

  test("synthesizes an error part for unmatched AI SDK tool-result stream parts", async () => {
    const toolCalls: Tool.Call[] = [];
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: (call) => toolCalls.push(call),
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-result",
            toolCallId: "forged-call",
            toolName: "weather",
            output: "forged",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    // #532-6: no Tool.Call/Tool.Result is emitted (no call to correlate),
    // but the anomaly is recorded as an error tool part.
    expect(toolCalls).toEqual([]);
    expect(toolResults).toEqual([]);
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      callID: "forged-call",
      state: { status: "error", error: "tool result for unknown call: forged" },
    });
  });

  test("projects AI SDK tool-error stream parts as failed tool results", async () => {
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
          };
          yield {
            type: "tool-error",
            toolCallId: "call-weather",
            error: "network down",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-weather",
      output: "network down",
      isError: true,
    });
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      callID: "call-weather",
      state: { status: "error", error: "network down" },
    });
  });

  test("keeps original tool-call input when matching tool-result has different input", async () => {
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onSnapshot: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
          };
          yield {
            type: "tool-result",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Tampered" },
            output: "sunny",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      callID: "call-weather",
      state: { status: "completed", input: { city: "Seoul" }, output: "sunny" },
    });
  });
});

describe("Processor tool output normalization", () => {
  test("serializes structured tool-result output instead of String coercion", async () => {
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-structured",
            toolName: "search",
            input: {},
          };
          yield {
            type: "tool-result",
            toolCallId: "call-structured",
            toolName: "search",
            output: { content: [{ type: "text", text: "hit" }] },
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toBe('{"content":[{"type":"text","text":"hit"}]}');
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      state: { status: "completed", output: '{"content":[{"type":"text","text":"hit"}]}' },
    });
  });
});

describe("Processor tool error normalization", () => {
  test("preserves Error messages in tool-error stream parts", async () => {
    const toolResults: Tool.Result[] = [];
    const sink: Sink = {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
      onSnapshot: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-error-object",
            toolName: "search",
            input: {},
          };
          yield {
            type: "tool-error",
            toolCallId: "call-error-object",
            error: new Error("network down"),
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "" });

    expect(toolResults).toHaveLength(1);
    // Error objects must not JSON-serialize to "{}".
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-error-object",
      output: "network down",
      isError: true,
    });
  });
});

describe("Processor abort settlement grace (#532 candidate 2)", () => {
  afterEach(() => {
    Bus.reset();
  });

  function captureSink(messages: Message.WithParts[]): Sink {
    return {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onSnapshot: () => undefined,
    };
  }

  function lastToolState(messages: Message.WithParts[]): Message.ToolPart["state"] | undefined {
    const parts = messages[messages.length - 1]?.parts ?? [];
    const tool = parts.find((part): part is Message.ToolPart => part.type === "tool");
    return tool?.state;
  }

  test("tool result already in the stream at abort settles as completed", async () => {
    const messages: Message.WithParts[] = [];
    const abortController = new AbortController();

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: abortController.signal,
      sink: captureSink(messages),
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-grace",
            toolName: "write_file",
            input: { path: "/tmp/x" },
          };
          abortController.abort();
          yield {
            type: "tool-result",
            toolCallId: "call-grace",
            toolName: "write_file",
            output: { output: "written", isError: false },
          };
        })(),
      }),
    });

    await expect(processor.process({ system: "" })).rejects.toMatchObject({
      name: "AbortError",
    });

    // The tool DID run (the SDK executes between tool-call and tool-result);
    // recording it as interrupted would misreport a real side effect.
    const state = lastToolState(messages);
    expect(state?.status).toBe("completed");
    if (state?.status === "completed") {
      expect(state.output).toBe("written");
      expect(state.time.end).toBeGreaterThanOrEqual(state.time.start);
    }
  });

  test("tool result that never arrives settles as interrupted after the grace window", async () => {
    const messages: Message.WithParts[] = [];
    const abortController = new AbortController();

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-tool-result",
      model,
      abort: abortController.signal,
      sink: captureSink(messages),
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-hang",
            toolName: "slow_tool",
            input: {},
          };
          abortController.abort();
          yield { type: "text-delta", id: "t1", text: "..." };
          // Result never arrives: block until the consumer stops pulling.
          await new Promise(() => undefined);
        })(),
      }),
    });

    const startedAt = Date.now();
    await expect(processor.process({ system: "" })).rejects.toMatchObject({
      name: "AbortError",
    });
    const elapsed = Date.now() - startedAt;
    // The grace window was actually attempted (~250ms) AND is bounded —
    // abort must not hang on a dead stream nor return before the grace.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1500);

    const state = lastToolState(messages);
    expect(state?.status).toBe("error");
    if (state?.status === "error") {
      // T1 vocabulary: abort-grace expiry advances the tool part with the
      // "interrupted" transition, which the fold projects as this error.
      expect(state.error).toBe("interrupted");
    }
  });
});
