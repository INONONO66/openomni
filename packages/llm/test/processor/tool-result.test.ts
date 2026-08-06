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

  test("ignores unmatched AI SDK tool-result stream parts", async () => {
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

    expect(toolCalls).toEqual([]);
    expect(toolResults).toEqual([]);
    expect(messages.at(-1)?.parts ?? []).toEqual([]);
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
