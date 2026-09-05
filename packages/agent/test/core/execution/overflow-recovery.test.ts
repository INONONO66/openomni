import { describe, expect, it } from "bun:test";
import { runAgent } from "../../../src/core/execution/run";
import { isContextOverflow } from "../../../src/core/retry";
import { collector } from "../../../src/observation/bus";
import { runInput } from "../../helpers/run-input";

const model = {
  id: "model",
  name: "model",
  providerID: "provider",
  limit: { context: 10_000, output: 100 },
};

const history = runInput([
  { role: "user", content: "the goal" },
  { role: "assistant", content: `old work one ${"filler ".repeat(120)}` },
  { role: "assistant", content: `old work two ${"filler ".repeat(120)}` },
  { role: "user", content: "recent question" },
  { role: "assistant", content: "recent answer" },
  { role: "user", content: "continue" },
]);

describe("context overflow recovery", () => {
  it("classifies provider overflow text without matching rate limits", () => {
    for (const message of [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens",
      "prompt is too long: 210000 tokens",
      "Request exceeds the context window",
      "too many tokens",
      "The input token count exceeds the maximum number of tokens allowed.",
      "Input is too long for requested model.",
    ]) {
      expect(isContextOverflow(new Error(message))).toBe(true);
    }
    expect(isContextOverflow(new Error("exceeded token rate limit of your current tier"))).toBe(
      false,
    );
    expect(isContextOverflow(new Error("context deadline exceeded"))).toBe(false);
  });

  it("does not blindly retry when compaction is unavailable and preserves the failure", async () => {
    const original = new Error("prompt is too long");
    let calls = 0;
    const running = runAgent(history, {
      events: collector(),
      model: { provider: "provider", id: "model" },
      llm: {
        resolveProviderModel: async () => model,
        run: async () => {
          calls += 1;
          return { type: "error", error: original };
        },
      },
    });

    await expect(running).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it("compacts once and the same-model retry sees rewritten history", async () => {
    const seen: number[] = [];
    let sawAnchor = false;
    let calls = 0;
    const result = await runAgent(history, {
      events: collector(),
      model: { provider: "provider", id: "model" },
      compaction: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 2,
        speculate: false,
        onSummarize: async () => "overflow checkpoint",
      },
      llm: {
        resolveProviderModel: async () => model,
        run: async (input) => {
          calls += 1;
          seen.push(input.messages.length);
          sawAnchor =
            calls === 2 &&
            input.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text.includes("overflow checkpoint"),
              ),
            );
          return calls === 1
            ? { type: "error", error: new Error("prompt is too long") }
            : { type: "stop" };
        },
      },
    });

    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(result.compactionCount).toBe(1);
    expect(seen[1]).toBeLessThan(seen[0] ?? 0);
    expect(sawAnchor).toBe(true);
  });

  it("stops after the one compacting retry and preserves the second overflow", async () => {
    const first = new Error("prompt is too long on first call");
    const second = new Error("prompt is too long on second call");
    let calls = 0;
    const running = runAgent(history, {
      events: collector(),
      model: { provider: "provider", id: "model" },
      compaction: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 2,
        speculate: false,
        onSummarize: async () => "overflow checkpoint",
      },
      llm: {
        resolveProviderModel: async () => model,
        run: async () => {
          calls += 1;
          return { type: "error", error: calls === 1 ? first : second };
        },
      },
    });

    await expect(running).rejects.toBe(second);
    expect(calls).toBe(2);
  });
});
