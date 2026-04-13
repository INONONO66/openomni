import { describe, expect, it } from "bun:test";
import { createPostTurnMiddleware } from "../../../../src/core/middleware/builtin/post-turn";
import type { MiddlewareContext } from "../../../../src/core/middleware";

function baseCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    timing: "post_turn",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("createPostTurnMiddleware", () => {
  it("handler returning inject → middleware returns inject verdict", async () => {
    const handler = () => ({ action: "inject" as const, message: "injected message" });
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.message).toBe("injected message");
    }
  });

  it("handler returning abort → middleware returns abort verdict", async () => {
    const handler = () => ({ action: "abort" as const, reason: "custom abort reason" });
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("abort");
    if (verdict.action === "abort") {
      expect(verdict.reason).toBe("custom abort reason");
    }
  });

  it("handler returning continue → middleware returns continue verdict", async () => {
    const handler = () => ({ action: "continue" as const });
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("handler throwing → middleware returns continue verdict (error isolation)", async () => {
    const handler = () => {
      throw new Error("handler failed");
    };
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("has priority 250", () => {
    const middleware = createPostTurnMiddleware(() => ({ action: "continue" }));
    expect(middleware.priority).toBe(250);
  });

  it("has timing post_turn", () => {
    const middleware = createPostTurnMiddleware(() => ({ action: "continue" }));
    expect(middleware.timing).toBe("post_turn");
  });

  it("has name builtin:post-turn", () => {
    const middleware = createPostTurnMiddleware(() => ({ action: "continue" }));
    expect(middleware.name).toBe("builtin:post-turn");
  });

  it("handler receives correct context", async () => {
    let receivedCtx: MiddlewareContext | undefined;
    const handler = (ctx: MiddlewareContext) => {
      receivedCtx = ctx;
      return { action: "continue" as const };
    };
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({
      turnCount: 5,
      isCompletion: true,
      continuationCount: 2,
      elapsedMs: 1000,
    });

    await middleware.fn(ctx);

    expect(receivedCtx?.turnCount).toBe(5);
    expect(receivedCtx?.isCompletion).toBe(true);
    expect(receivedCtx?.continuationCount).toBe(2);
    expect(receivedCtx?.elapsedMs).toBe(1000);
  });

  it("handler can be async", async () => {
    const handler = async () => {
      await Promise.resolve();
      return { action: "continue" as const };
    };
    const middleware = createPostTurnMiddleware(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });
});
