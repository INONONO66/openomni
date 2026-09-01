import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { anthropicModel as model, assistantMessage as buildAssistantMessage } from "../helpers/fixtures";
import type { Message, Tool } from "@openomni/protocol";
import type { Sink } from "../../src/sink";
import { Bus } from "@openomni/telemetry";
import { Processor } from "../../src/processor";
import type { StreamEvent } from "../../src/processor/stream-events";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ToolProjectionCase = {
  readonly name: string;
  readonly chunks: readonly StreamEvent[];
  readonly toolNames?: ReadonlyMap<string, string>;
  readonly expectedCalls?: Tool.Call[];
  readonly expectedResults?: number;
  readonly expectedResult?: Partial<Tool.Result>;
  readonly expectedPart: {
    readonly callID: string;
    readonly tool?: string;
    readonly state: Record<string, unknown>;
  };
};

const toolProjectionCases: ToolProjectionCase[] = [
  {
    name: "restores dotted internal names through the reverse map",
    toolNames: new Map([["message_send", "message.send"]]),
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-send",
        toolName: "message_send",
        input: { text: "hi" },
      },
      { type: "tool-result", toolCallId: "call-send", toolName: "message_send", output: "sent" },
      { type: "finish" },
    ],
    expectedCalls: [
      { id: "call-send", tool: "message.send", input: { text: "hi" } },
    ],
    expectedPart: {
      callID: "call-send",
      tool: "message.send",
      state: { status: "completed", title: "message.send" },
    },
  },
  {
    name: "synthesizes an error part for unmatched results",
    chunks: [
      {
        type: "tool-result",
        toolCallId: "forged-call",
        toolName: "weather",
        output: "forged",
      },
      { type: "finish" },
    ],
    expectedCalls: [],
    expectedResults: 0,
    expectedPart: {
      callID: "forged-call",
      state: { status: "error", error: "tool result for unknown call: forged" },
    },
  },
  {
    name: "projects tool-error parts as failed results",
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Seoul" },
      },
      { type: "tool-error", toolCallId: "call-weather", error: "network down" },
      { type: "finish" },
    ],
    expectedResults: 1,
    expectedResult: { toolCallId: "call-weather", output: "network down", isError: true },
    expectedPart: {
      callID: "call-weather",
      state: { status: "error", error: "network down" },
    },
  },
  {
    name: "keeps original call input when a result supplies different input",
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Seoul" },
      },
      {
        type: "tool-result",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Tampered" },
        output: "sunny",
      },
      { type: "finish" },
    ],
    expectedPart: {
      callID: "call-weather",
      state: { status: "completed", input: { city: "Seoul" }, output: "sunny" },
    },
  },
];

describe("Processor tool result projection", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("projects AI SDK tool-call and tool-result stream parts once", async () => {
    const toolCalls: Tool.Call[] = [];
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const toolCallObserved = deferred();
    const toolResultReleased = deferred();
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: (call) => {
        toolCalls.push(call);
        toolCallObserved.resolve();
      },
      onToolResult: (result) => toolResults.push(result),
    };

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-tool-result", "session-tool-result", "parent-tool-result"),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
          };
          await toolResultReleased.promise;
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

    const processing = processor.process({ system: "" });
    await toolCallObserved.promise;
    const runningSnapshot = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.state.status === "running");
    expect(runningSnapshot).toBeDefined();
    toolResultReleased.resolve();
    await processing;

    expect(toolCalls).toEqual([{ id: "call-weather", tool: "weather", input: { city: "Seoul" } }]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-weather",
      output: "sunny",
    });
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
    expect(state.time.end).toBeGreaterThanOrEqual(state.time.start);
  });

  test.each(toolProjectionCases)(
    "$name",
    async ({ chunks, toolNames, expectedCalls, expectedResults, expectedResult, expectedPart }) => {
      const toolCalls: Tool.Call[] = [];
      const toolResults: Tool.Result[] = [];
      const messages: Message.WithParts[] = [];
      const sink: Sink = {
        onMessage: (message) => messages.push(message),
        onToolCall: (call) => toolCalls.push(call),
        onToolResult: (result) => toolResults.push(result),
      };

      const processor = Processor.create({
        assistantMessage: buildAssistantMessage(
          "msg-tool-result",
          "session-tool-result",
          "parent-tool-result",
        ),
        sessionID: "session-tool-result",
        model,
        abort: new AbortController().signal,
        sink,
        events: Bus,
        toolNames,
        trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
        createStream: async () => ({
          fullStream: (async function* () {
            yield* chunks;
          })(),
        }),
      });

      await processor.process({ system: "" });

      if (expectedCalls !== undefined) expect(toolCalls).toEqual(expectedCalls);
      if (expectedResults !== undefined) expect(toolResults).toHaveLength(expectedResults);
      if (expectedResult !== undefined) expect(toolResults[0]).toMatchObject(expectedResult);
      const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
      expect(toolPart).toMatchObject(expectedPart);
    },
  );
});

describe("Processor tool output normalization", () => {
  test("serializes structured tool-result output instead of String coercion", async () => {
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
    };

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-tool-result", "session-tool-result", "parent-tool-result"),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
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
    };

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-tool-result", "session-tool-result", "parent-tool-result"),
      sessionID: "session-tool-result",
      model,
      abort: new AbortController().signal,
      sink,
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
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
    mock.restore();
  });

  function captureSink(messages: Message.WithParts[]): Sink {
    return {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: () => undefined,
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
      assistantMessage: buildAssistantMessage("msg-tool-result", "session-tool-result", "parent-tool-result"),
      sessionID: "session-tool-result",
      model,
      abort: abortController.signal,
      sink: captureSink(messages),
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-grace",
            toolName: "write_file",
            input: { path: "/tmp/x" },
          };
          abortController.abort();
          // The grace drain must skip unrelated buffered events and keep
          // pulling until the exact pending tool settles.
          yield { type: "text-delta", id: "buffered-text", text: "ignored during abort" };
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

  test("tool result that never arrives settles as interrupted when the grace timer fires", async () => {
    const messages: Message.WithParts[] = [];
    const abortController = new AbortController();
    const scheduledDelays: number[] = [];
    spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
        scheduledDelays.push(delay ?? 0);
        queueMicrotask(() => callback());
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-tool-result", "session-tool-result", "parent-tool-result"),
      sessionID: "session-tool-result",
      model,
      abort: abortController.signal,
      sink: captureSink(messages),
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-tool-result" },
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

    await expect(processor.process({ system: "" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(scheduledDelays).toContain(250);

    const state = lastToolState(messages);
    expect(state?.status).toBe("error");
    if (state?.status === "error") {
      // T1 vocabulary: abort-grace expiry advances the tool part with the
      // "interrupted" transition, which the fold projects as this error.
      expect(state.error).toBe("interrupted");
    }
  });
});
