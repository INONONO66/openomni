import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import { createCompactionPolicy } from "../../../src/compaction";
import { isContextOverflow } from "../../../src/core/retry";
import { handleError } from "../../../src/core/execution/turn";
import { runAgent } from "../../../src/core/execution/run";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

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
      "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
      "Input is too long for requested model.",
    ]) {
      expect(isContextOverflow(new Error(message))).toBe(true);
    }
    expect(isContextOverflow(new Error("rate limit exceeded, retry later"))).toBe(false);
    expect(isContextOverflow(new Error("connection reset"))).toBe(false);
    expect(isContextOverflow(new Error("context deadline exceeded"))).toBe(false);
    expect(isContextOverflow(new Error("exceeded token rate limit of your current tier"))).toBe(
      false,
    );
    expect(isContextOverflow(new Error("max_tokens must be at most 4096"))).toBe(false);
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

/**
 * #726 review F7: the end-to-end pin. A hand-typed Error into handleError
 * proves nothing about the real chain (Run.Outcome error → run.ts rethrow →
 * handleError → seam → retried call with REWRITTEN history). If a future
 * change wraps the provider message or drops the state mutation, this fails
 * — the L4 lesson, pinned.
 */
describe("context-overflow recovery through a real run (L5)", () => {
  it("first call overflows, the seam compacts, the retry sees the rewritten history", async () => {
    const seen: number[] = [];
    let sawAnchor = false;
    let calls = 0;

    const bulky = "filler ".repeat(120);
    const result = await runAgent(
      runInput([
        { role: "user", content: "the goal" },
        { role: "assistant", content: `old work one ${bulky}` },
        { role: "assistant", content: `old work two ${bulky}` },
        { role: "user", content: "recent question" },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "continue" },
      ]),
      {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        middleware: [
          createCompactionPolicy({
            contextWindowTokens: 100,
            protectRecentMessages: 2,
            onSummarize: async () => "overflow checkpoint",
            events: Bus,
            priority: 900,
          }),
        ],
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async (input) => {
            calls += 1;
            const messages = (input.messages ?? []) as Array<{
              parts?: Array<{ type?: string; text?: string }>;
            }>;
            seen.push(messages.length);
            sawAnchor =
              calls === 2 &&
              messages.some((m) =>
                (m.parts ?? []).some(
                  (p) => p.type === "text" && (p.text ?? "").includes("overflow checkpoint"),
                ),
              );
            if (calls === 1) {
              // The exact shape run.ts rethrows from a Run.Outcome error.
              return {
                type: "error",
                error: {
                  name: "AI_APICallError",
                  message: "prompt is too long: 210856 tokens > 200000 maximum",
                  stack: "",
                },
              };
            }
            return createStopOutcome();
          },
        }),
      },
    );

    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
    // The retry's model call saw the compacted, anchor-headed history —
    // strictly fewer messages than the first attempt, anchor render present.
    expect(seen[1]).toBeLessThan(seen[0] ?? 0);
    expect(sawAnchor).toBe(true);
  });
});
