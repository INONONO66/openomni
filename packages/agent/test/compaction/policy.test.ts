import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Compaction } from "../../src/compaction";
import { collector } from "../../src/observation/bus";
import { resolveCompactionGeometry } from "../../src/compaction/geometry";

function user(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "policy-session",
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "", modelID: "" },
    },
    parts: [
      { id: `${id}-text`, sessionID: "policy-session", messageID: id, type: "text", text: id },
    ],
  };
}

function assistant(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "policy-session",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-text`, sessionID: "policy-session", messageID: id, type: "text", text: id },
    ],
  };
}

const identity = { traceId: "trace", sessionId: "policy-session", runId: "run" };

describe("compaction geometry and apply policy", () => {
  it("uses adaptive geometry instead of cumulative run spend", () => {
    expect(Compaction.shouldCompact(449, { contextWindowTokens: 1000 })).toBe(false);
    expect(Compaction.shouldCompact(450, { contextWindowTokens: 1000 })).toBe(true);
  });

  it("reserves configured headroom before the ratio threshold", () => {
    expect(
      resolveCompactionGeometry({ contextWindowTokens: 1000, reserveTokens: 600 }).thresholdTokens,
    ).toBe(400);
  });

  it("moves a low-yield next threshold later", () => {
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 1000,
        previousYield: { savedTokens: 20, tokensBefore: 500 },
      }).thresholdTokens,
    ).toBe(500);
  });

  it("cuts at a user boundary when the threshold seam fires", async () => {
    const messages = Array.from({ length: 8 }, (_entry, index) => user(`u${index}`));
    const result = await Compaction.compact(
      messages,
      { contextWindowTokens: 1000, protectRecentMessages: 2 },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 900 },
    );
    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it("falls back to a user-boundary cut when summarization fails", async () => {
    const messages = [
      user("fallback-user-0"),
      ...Array.from({ length: 5 }, (_entry, index) => assistant(`fallback-assistant-${index}`)),
      user("fallback-user-1"),
      assistant("fallback-tail"),
    ];
    const result = await Compaction.compact(
      messages,
      {
        contextWindowTokens: 1000,
        protectRecentMessages: 2,
        onSummarize: async () => {
          throw new Error("summarizer unavailable");
        },
      },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 900 },
    );
    expect(result).toMatchObject({ compacted: true, summarizerFailed: true });
    expect(result.messages).toHaveLength(2);
  });

  it("records nothing reclaimed when the protected tail covers history", async () => {
    const messages = [user("u0")];
    const result = await Compaction.compact(
      messages,
      { contextWindowTokens: 1000, protectRecentMessages: 2 },
      identity,
      collector(),
      { trigger: "yield", measuredTokens: 900 },
    );
    expect(result).toMatchObject({ compacted: false, removedCount: 0 });
  });
});
