import { afterEach, describe, expect, test } from "bun:test";
import { anthropicModel as model, assistantMessage as buildAssistantMessage } from "../helpers/fixtures";
import type { Message, Tool, Transcript } from "@openomni/protocol";
import type { Sink } from "../../src/sink";
import { Bus } from "@openomni/telemetry";
import { APIError } from "../../src/error";
import { Processor } from "../../src/processor";

type Capture = {
  sink: Sink;
  messages: Message.WithParts[];
  facts: Transcript.Fact[];
  toolResults: Tool.Result[];
};

function capture(): Capture {
  const messages: Message.WithParts[] = [];
  const facts: Transcript.Fact[] = [];
  const toolResults: Tool.Result[] = [];
  return {
    sink: {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: (result) => toolResults.push(result),
      onFact: (fact) => facts.push(fact),
    },
    messages,
    facts,
    toolResults,
  };
}

function streamOf(chunks: Array<Record<string, unknown>>) {
  return async () => ({
    fullStream: (async function* () {
      yield* chunks as Array<{ type: string }>;
    })(),
  });
}

function createProcessor(cap: Capture, overrides: Partial<Processor.ProcessorOptions> = {}) {
  return Processor.create({
    assistantMessage: buildAssistantMessage("msg-fold", "session-fold", "parent-fold"),
    sessionID: "session-fold",
    model,
    abort: new AbortController().signal,
    sink: cap.sink,
    events: Bus,
    trace: { traceId: "trace-processor-test", sessionId: "session-fold" },
    createStream: streamOf([{ type: "finish" }]),
    ...overrides,
  });
}

function retryableError() {
  return new APIError({
    message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
    isRetryable: true,
    responseHeaders: { "retry-after-ms": "1" },
  });
}

describe("Processor fold-based emission (#545 T2)", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("emits onMessage only at part boundaries, never per token", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " " },
        { type: "text-delta", text: "World" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    // Boundaries only: part.appended (open, empty), part.advanced (completed
    // with the full text), message.finished. Deltas emit nothing.
    const timeline = cap.messages.map(
      (message) =>
        message.parts.find((part): part is Message.TextPart => part.type === "text")?.text,
    );
    expect(timeline).toEqual(["", "Hello World", "Hello World"]);
    expect(cap.messages).toHaveLength(3);
  });

  test("already-emitted snapshots are immune to later stream progress", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hello" },
        { type: "text-end", providerMetadata: {} },
        {
          type: "step-finish",
          finishReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
          providerMetadata: {},
        },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    // The snapshot captured when the text part completed must still describe
    // that instant: no finish reason, no token totals stamped afterwards.
    const atTextCompleted = cap.messages[1];
    expect(atTextCompleted?.info.role).toBe("assistant");
    if (atTextCompleted?.info.role !== "assistant") throw new Error("expected assistant info");
    expect(atTextCompleted.info.finish).toBeUndefined();
    expect(atTextCompleted.info.tokens.input).toBe(0);
    expect(atTextCompleted.info.time.completed).toBeUndefined();

    // While the final view carries the folded finish and usage.
    expect(processor.message.finish).toBe("stop");
    expect(processor.message.tokens.input).toBe(10);
  });

  test("emits transcript facts in fold order with attempt identity", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hi" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    expect(cap.facts.map((fact) => fact.type)).toEqual([
      "message.created",
      "part.appended",
      "part.advanced",
      "message.finished",
    ]);
    const attemptIds = new Set(cap.facts.map((fact) => fact.attemptId));
    expect(attemptIds.size).toBe(1);
    const finished = cap.facts.at(-1);
    if (finished?.type !== "message.finished") throw new Error("expected message.finished");
    expect(finished.finish).toBe("stop");
    expect(finished.usage).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  });

  test("failed-attempt parts do not re-emit into the retry attempt", async () => {
    let attemptCount = 0;
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: async () => ({
        fullStream: (async function* () {
          attemptCount++;
          if (attemptCount === 1) {
            yield { type: "text-start", providerMetadata: {} };
            yield { type: "text-delta", text: "draft that must not leak" };
            throw retryableError();
          }
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "ok" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "", promptText: "" });

    expect(attemptCount).toBe(2);
    const finalParts = cap.messages.at(-1)?.parts ?? [];
    const finalTexts = finalParts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text);
    expect(finalTexts).toEqual(["ok"]);
  });

  test("retry closes the failed attempt with finish error before the next attempt starts", async () => {
    let attemptCount = 0;
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: async () => ({
        fullStream: (async function* () {
          attemptCount++;
          if (attemptCount === 1) {
            yield { type: "text-start", providerMetadata: {} };
            throw retryableError();
          }
          yield { type: "finish" };
        })(),
      }),
    });

    await processor.process({ system: "", promptText: "" });

    const kinds = cap.facts.map((fact) => `${fact.type}@${fact.attemptId}`);
    const created = cap.facts.filter((fact) => fact.type === "message.created");
    expect(created).toHaveLength(2);
    expect(created[0]?.attemptId).not.toBe(created[1]?.attemptId);

    const firstFinishedIndex = cap.facts.findIndex((fact) => fact.type === "message.finished");
    const secondCreatedIndex = cap.facts.findIndex(
      (fact, index) => fact.type === "message.created" && index > 0,
    );
    expect(firstFinishedIndex).toBeGreaterThan(-1);
    expect(firstFinishedIndex).toBeLessThan(secondCreatedIndex);
    const firstFinished = cap.facts[firstFinishedIndex];
    if (firstFinished?.type !== "message.finished") throw new Error("expected message.finished");
    expect(firstFinished.finish).toBe("error");
    expect(kinds.at(-1)).toContain("message.finished");
  });

  test("length finish fails incomplete tool calls with no salvage", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "tool-call", toolCallId: "call-cut", toolName: "lookup", input: { q: "x" } },
        {
          type: "step-finish",
          finishReason: "length",
          usage: { inputTokens: 5, outputTokens: 9 },
          providerMetadata: {},
        },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const toolPart = cap.messages
      .at(-1)
      ?.parts.find((part): part is Message.ToolPart => part.type === "tool");
    expect(toolPart?.state.status).toBe("error");
    if (toolPart?.state.status !== "error") throw new Error("expected error tool state");
    expect(toolPart.state.error).toBe("truncated output: tool call incomplete");
    // finish=length is never rewritten.
    expect(processor.message.finish).toBe("length");
    expect(cap.toolResults).toHaveLength(1);
    expect(cap.toolResults[0]).toMatchObject({ toolCallId: "call-cut", isError: true });
  });

  test("opens a text block for an orphan text-delta (malformed sequence normalization)", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-delta", text: "orphan" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const texts = (cap.messages.at(-1)?.parts ?? [])
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text);
    expect(texts).toEqual(["orphan"]);
  });

  test("ignores a duplicate block end", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "once" },
        { type: "text-end", providerMetadata: {} },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const texts = (cap.messages.at(-1)?.parts ?? [])
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text);
    expect(texts).toEqual(["once"]);
  });

  test("closes an open text block before a second start", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "first" },
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "second" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const texts = (cap.messages.at(-1)?.parts ?? [])
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text);
    expect(texts).toEqual(["first", "second"]);
  });

  test("opens and settles reasoning for an orphan delta", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "reasoning-delta", id: "orphan", text: "inferred start" },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const reasoning = cap.messages
      .at(-1)
      ?.parts.find((part): part is Message.ReasoningPart => part.type === "reasoning");
    expect(reasoning?.text).toBe("inferred start");
    expect(reasoning?.time.end).toBeNumber();
  });

  test("ignores a duplicate reasoning end", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", text: "once" },
        { type: "reasoning-end", id: "r1" },
        { type: "reasoning-end", id: "r1" },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const reasoning = (cap.messages.at(-1)?.parts ?? []).filter(
      (part): part is Message.ReasoningPart => part.type === "reasoning",
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("once");
  });

  test("captures the provider reasoning signature on the completed part", async () => {
    const cap = capture();
    const processor = createProcessor(cap, {
      createStream: streamOf([
        { type: "reasoning-start", id: "r1", providerMetadata: {} },
        { type: "reasoning-delta", id: "r1", text: "thinking" },
        {
          type: "reasoning-delta",
          id: "r1",
          text: "",
          providerMetadata: { anthropic: { signature: "sig-abc" } },
        },
        { type: "reasoning-end", id: "r1" },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const reasoning = cap.messages
      .at(-1)
      ?.parts.find((part): part is Message.ReasoningPart => part.type === "reasoning");
    expect(reasoning?.text).toBe("thinking");
    expect(reasoning?.signature).toBe("sig-abc");
  });
});
