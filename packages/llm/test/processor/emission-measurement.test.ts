import { describe, expect, test } from "bun:test";
import type { Message, Sink } from "@openomni/protocol";
import { Processor } from "../../src/processor";
import type { Provider } from "../../src/provider";
import { Bus } from "@openomni/telemetry";

/**
 * #545 T2 measurement harness: streams a fixed synthetic 2000-delta/3-part
 * scenario and reports how much the sink actually receives. Run the same
 * harness on a scratch checkout of main (without the boundary-count
 * assertion) to get the before numbers for the PR body.
 *
 * Emission volume = onMessage call count and total serialized bytes
 * (sum of JSON.stringify(message).length per call) as the allocation proxy.
 */

const DELTA = "tok ";
const REASONING_DELTAS = 400;
const TEXT_DELTAS_PER_BLOCK = 800;

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "msg-measure",
    sessionID: "session-measure",
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-measure",
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

function scenario(): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [{ type: "step-start" }];
  chunks.push({ type: "reasoning-start", id: "r1", providerMetadata: {} });
  for (let i = 0; i < REASONING_DELTAS; i++) {
    chunks.push({ type: "reasoning-delta", id: "r1", text: DELTA });
  }
  chunks.push({ type: "reasoning-end", id: "r1", providerMetadata: {} });
  for (let block = 0; block < 2; block++) {
    chunks.push({ type: "text-start", providerMetadata: {} });
    for (let i = 0; i < TEXT_DELTAS_PER_BLOCK; i++) {
      chunks.push({ type: "text-delta", text: DELTA });
    }
    chunks.push({ type: "text-end", providerMetadata: {} });
  }
  chunks.push({
    type: "step-finish",
    finishReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 2000 },
    providerMetadata: {},
  });
  chunks.push({ type: "finish" });
  return chunks;
}

describe("Processor emission measurement (#545 T2)", () => {
  test("2000-delta/3-part scenario: onMessage volume", async () => {
    let onMessageCalls = 0;
    let serializedBytes = 0;
    let lastMessage: Message.WithParts | undefined;
    const sink: Sink = {
      onMessage: (message) => {
        onMessageCalls += 1;
        serializedBytes += JSON.stringify(message).length;
        lastMessage = message;
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: assistantMessage(),
      sessionID: "session-measure",
      model,
      abort: new AbortController().signal,
      sink,
      events: Bus,
      trace: { traceId: "trace-processor-test", sessionId: "session-measure" },
      createStream: async () => ({
        fullStream: (async function* () {
          yield* scenario() as Array<{ type: string }>;
        })(),
      }),
    });

    await processor.process({ system: "" });

    console.log(
      `[measurement] onMessage calls: ${onMessageCalls}, serialized bytes: ${serializedBytes}`,
    );

    // Content sanity: the boundary snapshots still deliver the full text.
    const texts = (lastMessage?.parts ?? [])
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text);
    expect(texts).toEqual([
      DELTA.repeat(TEXT_DELTAS_PER_BLOCK).trimEnd(),
      DELTA.repeat(TEXT_DELTAS_PER_BLOCK).trimEnd(),
    ]);
    const reasoning = (lastMessage?.parts ?? []).find(
      (part): part is Message.ReasoningPart => part.type === "reasoning",
    );
    expect(reasoning?.text).toBe(DELTA.repeat(REASONING_DELTAS).trimEnd());

    // Boundary-only emission: 2000 deltas may not inflate the call count.
    // step-start(1) + reasoning open/close(2) + two text blocks(4) +
    // step-finish(1) + message.finished(1) = 9.
    expect(onMessageCalls).toBe(9);
  });
});
