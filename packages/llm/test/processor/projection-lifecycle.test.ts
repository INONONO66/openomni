import { afterEach, describe, expect, test } from "bun:test";
import { Operational, type Message, type Run, type Sink, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "msg-projection",
    sessionID: "session-projection",
    role: "assistant",
    time: { created: 1 },
    parentID: "parent-projection",
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

function sink(messages: Message.WithParts[], snapshots: Run.Snapshot[]): Sink {
  return {
    onMessage: (message) => messages.push(message),
    onToolCall: (_call: Tool.Call) => undefined,
    onToolResult: (_result: Tool.Result) => undefined,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  };
}

describe("Processor projection lifecycle", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("projects reasoning and step lifecycle with exact Bus observations", async () => {
    const messages: Message.WithParts[] = [];
    const snapshots: Run.Snapshot[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const unsubscribe = Bus.subscribe(Operational.Info, (event) => {
      if (event.component === "llm.processor") {
        const { time: _time, ...stable } = event;
        observations.push(stable);
      }
    });
    const message = assistantMessage();
    const processor = Processor.create({
      assistantMessage: message,
      sessionID: message.sessionID,
      model,
      abort: new AbortController().signal,
      sink: sink(messages, snapshots),
      createStream: async () => ({
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "reason-1", providerMetadata: { source: "start" } };
          yield { type: "reasoning-delta", id: "reason-1", text: "first " };
          yield {
            type: "reasoning-delta",
            id: "reason-1",
            text: "second   ",
            providerMetadata: { source: "delta" },
          };
          yield { type: "reasoning-end", id: "reason-1", providerMetadata: { source: "end" } };
          yield { type: "step-start" };
          yield {
            type: "step-finish",
            finishReason: "tool_use",
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              reasoningTokens: 3,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
            },
          };
          yield { type: "finish" };
        })(),
      }),
    });

    expect(await processor.process({ messages: [], model, system: "" })).toBe("stop");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    unsubscribe();

    const parts = messages.at(-1)?.parts ?? [];
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "step-start", "step-finish"]);
    const reasoning = parts[0];
    if (reasoning?.type !== "reasoning") throw new Error("expected reasoning projection");
    expect(reasoning).toMatchObject({
      type: "reasoning",
      sessionID: "session-projection",
      messageID: "msg-projection",
      text: "first second",
      metadata: { source: "end" },
    });
    expect(typeof reasoning.time.start).toBe("number");
    expect(typeof reasoning.time.end).toBe("number");
    expect(parts[2]).toMatchObject({
      type: "step-finish",
      reason: "tool_use",
      cost: 0,
      tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
    });
    expect(snapshots.map((snapshot) => snapshot.state)).toEqual([
      { type: "busy" },
      { type: "idle" },
    ]);
    expect(observations).toEqual([
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.snapshot",
        context: { stateType: "busy" },
      },
      ...[1, 1, 1, 1, 2, 3].map((partCount) => ({
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.message",
        context: { role: "assistant", messageId: "msg-projection", partCount },
      })),
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.snapshot",
        context: { stateType: "idle" },
      },
    ]);
  });

  test("publishes exact tool observation payloads", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const unsubscribe = Bus.subscribe(Operational.Info, (event) => {
      if (event.component === "llm.processor") {
        const { time: _time, ...stable } = event;
        observations.push(stable);
      }
    });
    const message = assistantMessage();
    const processor = Processor.create({
      assistantMessage: message,
      sessionID: message.sessionID,
      model,
      abort: new AbortController().signal,
      sink: sink([], []),
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "call-lookup",
            toolName: "lookup",
            input: { zebra: true, alpha: 1 },
          };
          yield {
            type: "tool-result",
            toolCallId: "call-lookup",
            toolName: "lookup",
            output: "ok",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ messages: [], model, system: "" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    unsubscribe();

    expect(observations).toEqual([
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.snapshot",
        context: { stateType: "busy" },
      },
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.message",
        context: { role: "assistant", messageId: "msg-projection", partCount: 1 },
      },
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.tool.started",
        context: {
          toolCallId: "call-lookup",
          toolName: "lookup",
          inputSummary: "alpha,zebra",
        },
      },
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.message",
        context: { role: "assistant", messageId: "msg-projection", partCount: 1 },
      },
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.tool.completed",
        context: { toolCallId: "call-lookup", outputLength: 2, isError: undefined },
      },
      {
        traceId: "session-projection",
        sessionId: "session-projection",
        component: "llm.processor",
        msg: "sink.snapshot",
        context: { stateType: "idle" },
      },
    ]);
  });

  test("accumulates assistant token usage across multiple steps", async () => {
    const message = assistantMessage();
    const messages: Message.WithParts[] = [];
    const processor = Processor.create({
      assistantMessage: message,
      sessionID: message.sessionID,
      model,
      abort: new AbortController().signal,
      sink: sink(messages, []),
      createStream: async () => ({
        fullStream: (async function* () {
          yield {
            type: "step-finish",
            finishReason: "tool_use",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              reasoningTokens: 7,
              cacheReadTokens: 5,
              cacheWriteTokens: 3,
            },
          };
          yield {
            type: "step-finish",
            finishReason: "end_turn",
            usage: {
              inputTokens: 40,
              outputTokens: 11,
              reasoningTokens: 2,
              cacheReadTokens: 4,
              cacheWriteTokens: 1,
            },
          };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ messages: [], model, system: "" });

    expect(processor.message.tokens).toEqual({
      input: 140,
      output: 31,
      reasoning: 9,
      cache: { read: 9, write: 4 },
    });
    expect(processor.message.finish).toBe("end_turn");
    expect(messages.at(-1)?.parts.filter((part) => part.type === "step-finish")).toHaveLength(2);
  });
});
