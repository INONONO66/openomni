import { describe, expect, it } from "bun:test";
import { createPostTurnPolicy } from "../../../../src/core/policy/builtin/post-turn";
import type { PolicyContext } from "../../../../src/core/policy";
import { abortRun, allow, inject } from "../../../helpers/policy-decision";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "turn.finish",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("createPostTurnPolicy", () => {
  it("handler returning inject → middleware returns inject verdict", async () => {
    const handler = () => inject("injected message", "test.post-turn", "injected-message");
    const middleware = createPostTurnPolicy(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(verdict.effects).toContainEqual({
      type: "prompt.inject_message",
      message: "injected message",
    });
  });

  it("handler returning abort → middleware returns abort verdict", async () => {
    const handler = () => abortRun("test.post-turn", "custom abort reason");
    const middleware = createPostTurnPolicy(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("custom abort reason");
  });

  it("handler returning continue → middleware returns continue verdict", async () => {
    const handler = () => allow("test.post-turn");
    const middleware = createPostTurnPolicy(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("handler throwing → middleware returns continue verdict (error isolation)", async () => {
    const handler = () => {
      throw new Error("handler failed");
    };
    const middleware = createPostTurnPolicy(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("has priority 250", () => {
    const middleware = createPostTurnPolicy(() => allow("test.post-turn"));
    expect(middleware.priority).toBe(250);
  });

  it("has timing turn.finish", () => {
    const middleware = createPostTurnPolicy(() => allow("test.post-turn"));
    expect(middleware.timing).toBe("turn.finish");
  });

  it("has name builtin:post-turn", () => {
    const middleware = createPostTurnPolicy(() => allow("test.post-turn"));
    expect(middleware.name).toBe("builtin:post-turn");
  });

  it("handler receives correct context", async () => {
    let receivedCtx: PolicyContext | undefined;
    const handler = (ctx: PolicyContext) => {
      receivedCtx = ctx;
      return allow("test.post-turn");
    };
    const middleware = createPostTurnPolicy(handler);
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
      return allow("test.post-turn");
    };
    const middleware = createPostTurnPolicy(handler);
    const ctx = baseCtx({ turnCount: 1 });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });
});
