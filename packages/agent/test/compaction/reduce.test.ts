import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { collector } from "@openomni/telemetry";
import { Compaction } from "../../src/compaction/compact";
import { elideToolOutputs } from "../../src/compaction/reduce";

const sessionID = "reduce-session";
let idCounter = 0;

function userMessage(text: string): Message.WithParts {
  idCounter += 1;
  const id = `reduce-user-${idCounter}`;
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
  };
}

function toolMessage(output: string): Message.WithParts {
  idCounter += 1;
  const id = `reduce-tool-${idCounter}`;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-tool`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "read_file",
        state: {
          status: "completed",
          input: {},
          output,
          title: "read_file",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

const options = { minOutputChars: 100, keepHeadChars: 20 };

describe("elideToolOutputs", () => {
  it("elides old bulky outputs, keeps identity, and leaves the protected tail intact", () => {
    const bulky = "x".repeat(500);
    const messages = [toolMessage(bulky), userMessage("u1"), toolMessage(bulky), userMessage("u2")];

    const result = elideToolOutputs(messages, 2, options);

    expect(result.elidedChars).toBe(500);
    const oldTool = result.messages[0]?.parts[0];
    if (oldTool?.type !== "tool" || oldTool.state.status !== "completed") throw new Error("shape");
    expect(oldTool.state.output).toBe(
      `[output elided by compaction: 500 chars]\n${"x".repeat(20)}`,
    );
    const originalPart = messages[0]?.parts[0];
    if (originalPart === undefined) throw new Error("shape");
    expect(oldTool.id).toBe(originalPart.id);
    // the protected tail's bulky output survives untouched
    const recentTool = result.messages[2]?.parts[0];
    if (recentTool?.type !== "tool" || recentTool.state.status !== "completed")
      throw new Error("shape");
    expect(recentTool.state.output).toBe(bulky);
    // input messages are not mutated
    const original = messages[0]?.parts[0];
    if (original?.type !== "tool" || original.state.status !== "completed")
      throw new Error("shape");
    expect(original.state.output).toBe(bulky);
  });

  it("is idempotent: a second pass over its own output finds nothing", () => {
    const messages = [toolMessage("x".repeat(500)), userMessage("u1"), userMessage("u2")];
    const once = elideToolOutputs(messages, 1, options);
    const twice = elideToolOutputs(once.messages, 1, options);

    expect(once.elidedChars).toBe(500);
    expect(twice.elidedChars).toBe(0);
    expect(twice.messages).toEqual(once.messages);
  });

  it("reclaims nothing from small outputs or non-completed tools", () => {
    const messages = [toolMessage("small"), userMessage("u1"), userMessage("u2")];
    expect(elideToolOutputs(messages, 1, options).elidedChars).toBe(0);
  });
});

describe("Compaction.compact with elision configured", () => {
  const trace = { traceId: "trace-reduce" };

  it("reduces instead of cutting while there is something to elide", async () => {
    const sink = collector();
    const messages = [
      userMessage("u0"),
      toolMessage("x".repeat(500)),
      userMessage("u1"),
      userMessage("u2"),
    ];

    const result = await Compaction.compact(
      messages,
      { contextWindowTokens: 100, protectRecentMessages: 2, elideToolOutputs: options },
      trace,
      sink,
    );

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.messages).toHaveLength(4);
    expect(sink.events.length).toBeGreaterThan(0);
  });

  it("falls back to the cut once elision has nothing left", async () => {
    const sink = collector();
    const messages = [
      userMessage("u0"),
      toolMessage("small"),
      userMessage("u1"),
      userMessage("u2"),
    ];

    const result = await Compaction.compact(
      messages,
      { contextWindowTokens: 100, protectRecentMessages: 2, elideToolOutputs: options },
      trace,
      sink,
    );

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBeGreaterThan(0);
  });
});
