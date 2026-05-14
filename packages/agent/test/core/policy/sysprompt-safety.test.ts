import { describe, expect, it, mock } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";

function baseCtx(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

describe("PolicyEngine dispatchSystemPrompt safety", () => {
  it("stops system prompt composition on abort", async () => {
    const engine = PolicyEngine.create();
    const after = mock(
      () =>
        ({
          action: "inject",
          message: "should-not-append",
          reason: "late",
          policyId: "test.late",
        }) as const,
    );

    engine.register({
      name: "abort-context",
      timing: "context.prepare",
      priority: 0,
      fn: () =>
        ({ action: "abort", reason: "context-aborted", policyId: "test.context-aborted" }) as const,
    });
    engine.register({ name: "after", timing: "context.prepare", priority: 10, fn: after });

    let thrown: unknown;
    try {
      await engine.dispatchSystemPrompt(baseCtx());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("context-aborted");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("stops system prompt composition on deny", async () => {
    const engine = PolicyEngine.create();
    const after = mock(
      () =>
        ({
          action: "inject",
          message: "should-not-append",
          reason: "late",
          policyId: "test.late",
        }) as const,
    );

    engine.register({
      name: "deny-context",
      timing: "context.prepare",
      priority: 0,
      fn: () =>
        ({ action: "deny", reason: "context-denied", policyId: "test.context-denied" }) as const,
    });
    engine.register({ name: "after", timing: "context.prepare", priority: 10, fn: after });

    let thrown: unknown;
    try {
      await engine.dispatchSystemPrompt(baseCtx());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("context-denied");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("keeps transform output when no abort or deny runs", async () => {
    const engine = PolicyEngine.create();

    engine.register({
      name: "transform-context",
      timing: "context.prepare",
      priority: 0,
      fn: () =>
        ({
          action: "transform",
          input: {
            systemPrompt: "PROMPT_A",
            prependContext: "prepend-a",
            appendContext: "append-a",
          },
          reason: "transform-context",
          policyId: "test.transform-context",
        }) as const,
    });

    const result = await engine.dispatchSystemPrompt(baseCtx());

    expect(result).toEqual({
      systemPrompt: "PROMPT_A",
      prependContext: "prepend-a",
      appendContext: "append-a",
    });
  });
});
