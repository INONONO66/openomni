import { describe, expect, it } from "bun:test";
import { createPostToolMiddleware } from "../../../../src/core/middleware/builtin/post-tool";
import type { MiddlewareContext } from "../../../../src/core/middleware";

function baseCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    timing: "post_tool_use",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("createPostToolMiddleware", () => {
  it("enricher returns string → transform verdict with appended output", async () => {
    const enricher = () => "enrichment text";
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolInput: { key: "value" },
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    expect(((verdict as Record<string, unknown>).input as Record<string, unknown>).output).toBe(
      "original output\nenrichment text",
    );
  });

  it("enricher returns null → continue verdict", async () => {
    const enricher = () => null;
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolInput: { key: "value" },
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("enricher receives correct tool context", async () => {
    let receivedCtx: MiddlewareContext | undefined;
    const enricher = (ctx: MiddlewareContext) => {
      receivedCtx = ctx;
      return "enrichment";
    };
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "my-tool",
      toolCallId: "call-456",
      toolInput: { param: "test" },
      toolOutput: "result",
    });

    await middleware.fn(ctx);

    expect(receivedCtx!.toolName).toBe("my-tool");
    expect(receivedCtx!.toolCallId).toBe("call-456");
    expect(receivedCtx!.toolInput).toEqual({ param: "test" });
    expect(receivedCtx!.toolOutput).toBe("result");
  });

  it("enricher throwing → continue verdict (error isolation)", async () => {
    const enricher = () => {
      throw new Error("enricher failed");
    };
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("enricher returns string with empty toolOutput → transform with enrichment only", async () => {
    const enricher = () => "enrichment text";
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    expect(((verdict as Record<string, unknown>).input as Record<string, unknown>).output).toBe(
      "enrichment text",
    );
  });

  it("has priority 200", () => {
    const middleware = createPostToolMiddleware(() => null);
    expect(middleware.priority).toBe(200);
  });

  it("has timing post_tool_use", () => {
    const middleware = createPostToolMiddleware(() => null);
    expect(middleware.timing).toBe("post_tool_use");
  });

  it("has name builtin:post-tool", () => {
    const middleware = createPostToolMiddleware(() => null);
    expect(middleware.name).toBe("builtin:post-tool");
  });

  it("enricher can be async", async () => {
    const enricher = async () => {
      await Promise.resolve();
      return "async enrichment";
    };
    const middleware = createPostToolMiddleware(enricher);
    const ctx = baseCtx({
      toolName: "test-tool",
      toolCallId: "call-123",
      toolOutput: "original output",
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    expect(((verdict as Record<string, unknown>).input as Record<string, unknown>).output).toBe(
      "original output\nasync enrichment",
    );
  });
});
