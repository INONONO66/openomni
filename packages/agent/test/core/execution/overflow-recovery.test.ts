import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import { createCompactionPolicy } from "../../../src/compaction";
import { isContextOverflow } from "../../../src/core/retry";
import { handleError } from "../../../src/core/execution/turn";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

/**
 * L5 (#715): a provider context-overflow re-enters the compaction seam —
 * blocking, once per run — then retries the call immediately. A second
 * overflow, or a seam that reclaims nothing, ends the run honestly. Blind
 * retry of the same prompt never happens (the overflow branch bypasses the
 * generic retry classification).
 */

const retryPolicy = { maxAttempts: 3, backoffMs: { initial: 0, multiplier: 1, max: 0 } };

function bulkyToolMessage(index: number): Message.WithParts {
  const id = `ovf-a-${index}`;
  return {
    info: {
      id,
      sessionID: "sess-1",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "t",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-tool`,
        sessionID: "sess-1",
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "x".repeat(6000),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

function engineWithCompaction() {
  const engine = PolicyEngine.create();
  engine.register(
    createCompactionPolicy({
      contextWindowTokens: 100,
      protectRecentMessages: 2,
      elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 100 },
      events: Bus,
      priority: 900,
    }),
  );
  return engine;
}

function overflowState() {
  const state = makeState();
  for (let index = 0; index < 4; index += 1) state.messages.push(bulkyToolMessage(index));
  state.lastCallContextTokens = 99;
  state.contextWindowTokens = 100;
  return state;
}

describe("context-overflow recovery (L5)", () => {
  it("classifies provider overflow text, not rate limits or aborts", () => {
    for (const message of [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens",
      "prompt is too long: 210000 tokens",
      "Request exceeds the context window",
      "too many tokens",
    ]) {
      expect(isContextOverflow(new Error(message))).toBe(true);
    }
    expect(isContextOverflow(new Error("rate limit exceeded, retry later"))).toBe(false);
    expect(isContextOverflow(new Error("connection reset"))).toBe(false);
  });

  it("re-enters the seam once and retries immediately when it reclaimed", async () => {
    const state = overflowState();
    const decision = await handleError(
      state,
      engineWithCompaction(),
      makeConfig(),
      makeAgentBase(),
      new Error("prompt is too long"),
      1,
      retryPolicy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") throw new Error("expected retry");
    expect(decision.backoffMs).toBe(0);
    expect(decision.failure.reason).toBe("context_overflow");
    expect(state.compactionCount).toBe(1);
    expect(state.overflowCompactionAttempted).toBe(true);
  });

  it("a second overflow ends the run honestly", async () => {
    const state = overflowState();
    const engine = engineWithCompaction();
    const first = await handleError(
      state,
      engine,
      makeConfig(),
      makeAgentBase(),
      new Error("prompt is too long"),
      1,
      retryPolicy,
    );
    expect(first.action).toBe("retry");
    const second = await handleError(
      state,
      engine,
      makeConfig(),
      makeAgentBase(),
      new Error("prompt is too long"),
      2,
      retryPolicy,
    );
    expect(second.action).toBe("throw");
    if (second.action !== "throw") throw new Error("expected throw");
    expect(second.failure.reason).toBe("context_overflow");
    // The seam ran exactly once — no second rewrite attempt.
    expect(state.compactionCount).toBe(1);
  });

  it("ends honestly when the seam reclaims nothing — never a blind retry", async () => {
    const state = makeState(); // one small user message: nothing to reclaim
    state.lastCallContextTokens = 99;
    state.contextWindowTokens = 100;
    const decision = await handleError(
      state,
      engineWithCompaction(),
      makeConfig(),
      makeAgentBase(),
      new Error("maximum context length exceeded"),
      1,
      retryPolicy,
    );
    expect(decision.action).toBe("throw");
    if (decision.action !== "throw") throw new Error("expected throw");
    expect(decision.failure.reason).toBe("context_overflow");
  });
});
