import { describe, expect, it } from "bun:test";
import { createPostToolPolicy } from "../../../../src/core/policy/builtin/post-tool";
import type { PolicyContext } from "../../../../src/core/policy";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "invoke.result",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function rewrittenOutput(
  verdict: Awaited<ReturnType<ReturnType<typeof createPostToolPolicy>["fn"]>>,
): string | undefined {
  return verdict.effects.find((effect) => effect.type === "tool.rewrite_output")?.output;
}

describe("createPostToolPolicy", () => {
  it("enricher returns string → transform verdict with appended output", async () => {
    const enricher = () => "enrichment text";
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolInput: { key: "value" },
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(rewrittenOutput(verdict)).toBe("original output\nenrichment text");
  });

  it("enricher returns null → continue verdict", async () => {
    const enricher = () => null;
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolInput: { key: "value" },
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("enricher receives correct tool context", async () => {
    let receivedCtx: PolicyContext | undefined;
    const enricher = (ctx: PolicyContext) => {
      receivedCtx = ctx;
      return "enrichment";
    };
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "my-tool",
      toolCallId: "call-456",
      toolInput: { param: "test" },
      toolOutput: "result",
    });

    await middleware.fn(ctx);

    expect(receivedCtx?.toolName).toBe("my-tool");
    expect(receivedCtx?.toolCallId).toBe("call-456");
    expect(receivedCtx?.toolInput).toEqual({ param: "test" });
    expect(receivedCtx?.toolOutput).toBe("result");
  });

  it("enricher throwing → continue verdict (error isolation)", async () => {
    const enricher = () => {
      throw new Error("enricher failed");
    };
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("enricher returns string with empty toolOutput → transform with enrichment only", async () => {
    const enricher = () => "enrichment text";
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(rewrittenOutput(verdict)).toBe("enrichment text");
  });

  it("has priority 200", () => {
    const middleware = createPostToolPolicy(() => null);
    expect(middleware.priority).toBe(200);
  });

  it("has timing invoke.result", () => {
    const middleware = createPostToolPolicy(() => null);
    expect(middleware.timing).toBe("invoke.result");
  });

  it("has name builtin:post-tool", () => {
    const middleware = createPostToolPolicy(() => null);
    expect(middleware.name).toBe("builtin:post-tool");
  });

  it("enricher can be async", async () => {
    const enricher = async () => {
      await Promise.resolve();
      return "async enrichment";
    };
    const middleware = createPostToolPolicy(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(rewrittenOutput(verdict)).toBe("original output\nasync enrichment");
  });
});
