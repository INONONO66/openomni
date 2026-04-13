import { describe, expect, it, mock } from "bun:test";
import type { Hook } from "@openomni/protocol";
import { MiddlewareEngine } from "../../../src/core/middleware";
import type { MiddlewareContext } from "../../../src/core/middleware";

function baseCtx(): Omit<MiddlewareContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

describe("MiddlewareEngine", () => {
  it("executes middleware in priority order (ascending)", async () => {
    const order: number[] = [];
    const engine = MiddlewareEngine.create();
    engine.register({
      name: "third",
      timing: "pre_turn",
      priority: 300,
      fn: () => {
        order.push(300);
        return { action: "continue" };
      },
    });
    engine.register({
      name: "first",
      timing: "pre_turn",
      priority: 100,
      fn: () => {
        order.push(100);
        return { action: "continue" };
      },
    });
    engine.register({
      name: "second",
      timing: "pre_turn",
      priority: 200,
      fn: () => {
        order.push(200);
        return { action: "continue" };
      },
    });

    await engine.dispatch("pre_turn", baseCtx());
    expect(order).toEqual([100, 200, 300]);
  });

  it("only runs middleware matching the dispatch timing", async () => {
    const engine = MiddlewareEngine.create();
    const postFn = mock(() => ({ action: "continue" }) as Hook.Verdict);
    const preFn = mock(() => ({ action: "continue" }) as Hook.Verdict);
    engine.register({ name: "post", timing: "post_turn", priority: 100, fn: postFn });
    engine.register({ name: "pre", timing: "pre_turn", priority: 100, fn: preFn });

    await engine.dispatch("pre_turn", baseCtx());

    expect(preFn).toHaveBeenCalledTimes(1);
    expect(postFn).toHaveBeenCalledTimes(0);
  });

  it("short-circuits on non-continue verdict", async () => {
    const engine = MiddlewareEngine.create();
    const third = mock(() => ({ action: "continue" }) as Hook.Verdict);
    engine.register({
      name: "a",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "continue" }),
    });
    engine.register({
      name: "b",
      timing: "pre_turn",
      priority: 200,
      fn: () => ({ action: "abort", reason: "stop" }),
    });
    engine.register({ name: "c", timing: "pre_turn", priority: 300, fn: third });

    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict).toEqual({ action: "abort", reason: "stop" });
    expect(third).toHaveBeenCalledTimes(0);
  });

  it("fail-open isolates thrown errors and continues chain", async () => {
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    globalObj.console.warn = mock(() => undefined);
    try {
      const engine = MiddlewareEngine.create();
      const after = mock(() => ({ action: "continue" }) as Hook.Verdict);
      engine.register({
        name: "boom",
        timing: "pre_turn",
        priority: 100,
        fn: () => {
          throw new Error("boom");
        },
      });
      engine.register({ name: "after", timing: "pre_turn", priority: 200, fn: after });

      const verdict = await engine.dispatch("pre_turn", baseCtx());
      expect(verdict).toEqual({ action: "continue" });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("fail-closed aborts chain on thrown error", async () => {
    const engine = MiddlewareEngine.create();
    const after = mock(() => ({ action: "continue" }) as Hook.Verdict);
    engine.register({
      name: "boom",
      timing: "pre_turn",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw new Error("boom");
      },
    });
    engine.register({ name: "after", timing: "pre_turn", priority: 200, fn: after });

    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict).toEqual({ action: "abort", reason: "middleware-error" });
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("skips middleware when agentType not in scope.agentType", async () => {
    const engine = MiddlewareEngine.create();
    const scoped = mock(() => ({ action: "continue" }) as Hook.Verdict);
    const unscoped = mock(() => ({ action: "continue" }) as Hook.Verdict);
    engine.register({
      name: "scoped",
      timing: "pre_turn",
      priority: 100,
      scope: { agentType: ["subagent"] },
      fn: scoped,
    });
    engine.register({ name: "unscoped", timing: "pre_turn", priority: 200, fn: unscoped });

    await engine.dispatch("pre_turn", { ...baseCtx(), agentType: "primary" });

    expect(scoped).toHaveBeenCalledTimes(0);
    expect(unscoped).toHaveBeenCalledTimes(1);
  });

  it("returns continue when no middleware registered", async () => {
    const engine = MiddlewareEngine.create();
    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict).toEqual({ action: "continue" });
  });

  it("runs middleware at multiple timings when timing is an array", async () => {
    const engine = MiddlewareEngine.create();
    const fn = mock(() => ({ action: "continue" }) as Hook.Verdict);
    engine.register({
      name: "multi",
      timing: ["pre_turn", "post_turn"],
      priority: 100,
      fn,
    });

    await engine.dispatch("pre_turn", baseCtx());
    await engine.dispatch("post_turn", baseCtx());
    await engine.dispatch("on_error", baseCtx());

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dispatchSystemPrompt merges systemPrompt (first wins) and concatenates contexts", async () => {
    const engine = MiddlewareEngine.create();
    engine.register({
      name: "prompt-a",
      timing: "on_system_prompt",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { systemPrompt: "PROMPT_A", appendContext: "append-a" },
      }),
    });
    engine.register({
      name: "prompt-b",
      timing: "on_system_prompt",
      priority: 200,
      fn: () => ({
        action: "transform",
        input: { systemPrompt: "PROMPT_B", prependContext: "prepend-b", appendContext: "append-b" },
      }),
    });
    engine.register({
      name: "inject-c",
      timing: "on_system_prompt",
      priority: 300,
      fn: () => ({ action: "inject", message: "append-c" }),
    });

    const result = await engine.dispatchSystemPrompt(baseCtx());
    expect(result.systemPrompt).toBe("PROMPT_A");
    expect(result.prependContext).toBe("prepend-b");
    expect(result.appendContext).toBe("append-a\n\nappend-b\n\nappend-c");
  });

  it("dispatchSystemPrompt propagates fail-closed errors", async () => {
    const engine = MiddlewareEngine.create();
    const testError = new Error("system-prompt-error");
    engine.register({
      name: "boom",
      timing: "on_system_prompt",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw testError;
      },
    });
    engine.register({
      name: "after",
      timing: "on_system_prompt",
      priority: 200,
      fn: () => ({ action: "inject", message: "should-not-run" }),
    });

    await expect(engine.dispatchSystemPrompt(baseCtx())).rejects.toThrow("system-prompt-error");
  });

  it("dispatchSystemPrompt isolates fail-open errors and continues", async () => {
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    globalObj.console.warn = mock(() => undefined);
    try {
      const engine = MiddlewareEngine.create();
      engine.register({
        name: "boom",
        timing: "on_system_prompt",
        priority: 100,
        failPolicy: "fail-open",
        fn: () => {
          throw new Error("fail-open-error");
        },
      });
      engine.register({
        name: "after",
        timing: "on_system_prompt",
        priority: 200,
        fn: () => ({ action: "inject", message: "append-after" }),
      });

      const result = await engine.dispatchSystemPrompt(baseCtx());
      expect(result.appendContext).toBe("append-after");
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });
});
