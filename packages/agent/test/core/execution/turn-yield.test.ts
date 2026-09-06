import { describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import { runAgent } from "../../../src/core/execution/run";
import { collector } from "../../../src/observation/bus";
import { runInput } from "../../helpers/run-input";

function assistant(reason: string, inputTokens = 900): Message.WithParts {
  return assistantWithReasons([reason], inputTokens);
}

function assistantWithReasons(reasons: readonly string[], inputTokens = 900): Message.WithParts {
  return {
    info: {
      id: "yield-assistant",
      sessionID: "yield-session",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: reasons.map((reason, index) => ({
      id: `yield-step-${index}`,
      sessionID: "yield-session",
      messageID: "yield-assistant",
      type: "step-finish" as const,
      reason,
      cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })),
  };
}

describe("window and steering yield", () => {
  it("arms the provider call from the resolved model window", async () => {
    const arms: Array<number | undefined> = [];
    await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider", limit: { context: 1000, output: 100 } }),
        run: async (input) => {
          arms.push(input.yieldAtInputTokens);
          return { type: "stop" };
        },
      },
    });
    expect(arms).toEqual([450]);
  });

  it("continues on a window yield and disarms the next turn after no rewrite", async () => {
    const arms: Array<number | undefined> = [];
    let calls = 0;
    await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider", limit: { context: 1000, output: 100 } }),
        run: async (input, sink: Sink) => {
          calls += 1;
          arms.push(input.yieldAtInputTokens);
          if (calls === 1) sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        },
      },
    });
    expect(arms).toEqual([450, undefined]);
  });

  it("applies compaction before continuing a window yield", async () => {
    const seen: number[] = [];
    let calls = 0;
    const bulky = "filler ".repeat(120);
    const result = await runAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: `old one ${bulky}` },
        { role: "assistant", content: `old two ${bulky}` },
        { role: "user", content: "recent" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "continue" },
      ]),
      {
        events: collector(),
        model: { provider: "provider", id: "model" },
        compaction: {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          speculate: false,
          onSummarize: async () => "window checkpoint",
        },
        llm: {
          resolveModel: async () => ({ id: "model", name: "model", providerID: "provider", limit: { context: 1000, output: 100 } }),
          run: async (input, sink: Sink) => {
            calls += 1;
            seen.push(input.messages.length);
            if (calls === 1) sink.onMessage(assistant("tool-calls"));
            return { type: "stop" };
          },
        },
      },
    );
    expect(seen[1]).toBeLessThan(seen[0] ?? 0);
    expect(result.compactionCount).toBe(1);
  });

  it("aborts active speculative preparation when the run settles", async () => {
    let aborted = false;
    let calls = 0;
    await runAgent(runInput([
      { role: "user", content: "goal" },
      { role: "assistant", content: "old answer one" },
      { role: "assistant", content: "old answer two" },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "recent answer" },
      { role: "user", content: "continue" },
    ]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      compaction: {
        contextWindowTokens: 100_000,
        protectRecentMessages: 2,
        onSummarize: async (_messages, _anchor, _budget, signal) => {
          calls += 1;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
          return "unused";
        },
      },
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider", limit: { context: 100_000, output: 100 } }),
        run: async (_input, sink: Sink) => {
          sink.onMessage(assistant("stop", 55_000));
          return { type: "stop" };
        },
      },
    });
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
  });

  it("treats unlimited tool calls as a window yield, never a step-cap terminal", async () => {
    let calls = 0;
    const result = await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      budget: { maxToolCalls: -1 },
      llm: {
        resolveModel: async () => ({
          id: "model",
          name: "model",
          providerID: "provider",
          limit: { context: 1000, output: 100 },
        }),
        run: async (_input, sink: Sink) => {
          calls += 1;
          if (calls === 1) {
            sink.onMessage(assistantWithReasons(Array.from({ length: 30 }, () => "tool-calls")));
          }
          return { type: "stop" };
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("continues a steering yield instead of reporting max-steps", async () => {
    let pending = true;
    let calls = 0;
    const result = await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      steeringPending: () => pending,
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider" }),
        run: async (input, sink: Sink) => {
          calls += 1;
          if (calls === 1) {
            input.shouldYield?.();
            pending = false;
            sink.onMessage(assistant("tool-calls"));
          }
          return { type: "stop" };
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("keeps the step cap terminal when steering also fired", async () => {
    let calls = 0;
    const result = await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      budget: { maxToolCalls: 1 },
      steeringPending: () => true,
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider" }),
        run: async (input, sink: Sink) => {
          calls += 1;
          input.shouldYield?.();
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.finishReason).toBe("max-steps");
  });

  it("prefers steering over window compaction", async () => {
    let pending = true;
    let calls = 0;
    const result = await runAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: `old ${"filler ".repeat(120)}` },
        { role: "assistant", content: `work ${"filler ".repeat(120)}` },
        { role: "user", content: "tail" },
      ]),
      {
        events: collector(),
        model: { provider: "provider", id: "model" },
        steeringPending: () => pending,
        compaction: {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          speculate: false,
          onSummarize: async () => "must not run",
        },
        llm: {
          resolveModel: async () => ({
            id: "model",
            name: "model",
            providerID: "provider",
            limit: { context: 1000, output: 100 },
          }),
          run: async (input, sink: Sink) => {
            calls += 1;
            if (calls === 1) {
              input.shouldYield?.();
              pending = false;
              sink.onMessage(assistant("tool-calls"));
            } else {
              sink.onMessage(assistant("stop", 100));
            }
            return { type: "stop" };
          },
        },
      },
    );
    expect(calls).toBe(2);
    expect(result.compactionCount).toBeUndefined();
  });

  it("reports the step cap honestly", async () => {
    const result = await runAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      budget: { maxToolCalls: 1 },
      llm: {
        resolveModel: async () => ({ id: "model", name: "model", providerID: "provider" }),
        run: async (_input, sink: Sink) => {
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        },
      },
    });
    expect(result.finishReason).toBe("max-steps");
  });
});
