import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { measuredContextTokens } from "../../src/compaction/measure";

function message(parts: Message.Part[], totalInput: number): Message.WithParts {
  return {
    info: {
      id: "measure-message",
      sessionID: "measure-session",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: totalInput, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

function step(input: number, read: number, write: number): Message.StepFinishPart {
  return {
    id: `step-${input}`,
    sessionID: "measure-session",
    messageID: "measure-message",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input, output: 1, reasoning: 0, cache: { read, write } },
  };
}

describe("measuredContextTokens", () => {
  it("uses the last model step rather than cumulative turn input", () => {
    expect(measuredContextTokens(message([step(900, 800, 0), step(1100, 1000, 0)], 2000))).toBe(
      1100,
    );
  });

  it("does not add cache lanes to cache-inclusive input", () => {
    expect(measuredContextTokens(message([step(1000, 900, 50)], 1000))).toBe(1000);
  });

  it("returns no measurement before a model step finishes", () => {
    expect(measuredContextTokens(message([], 0))).toBeUndefined();
  });
});
