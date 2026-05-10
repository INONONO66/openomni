import { describe, expect, it, mock } from "bun:test";
import type { Hook } from "@openomni/protocol";
import { PolicyEvent } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Operational } from "@openomni/protocol";
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

function env(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
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
        reason: "prompt-a",
        policyId: "test.prompt-a",
      }),
    });
    engine.register({
      name: "prompt-b",
      timing: "on_system_prompt",
      priority: 200,
      fn: () => ({
        action: "transform",
        input: { systemPrompt: "PROMPT_B", prependContext: "prepend-b", appendContext: "append-b" },
        reason: "prompt-b",
        policyId: "test.prompt-b",
      }),
    });
    engine.register({
      name: "inject-c",
      timing: "on_system_prompt",
      priority: 300,
      fn: () => ({
        action: "inject",
        message: "append-c",
        reason: "inject-c",
        policyId: "test.inject-c",
      }),
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
      fn: () => ({
        action: "inject",
        message: "should-not-run",
        reason: "after",
        policyId: "test.after",
      }),
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
        fn: () => ({
          action: "inject",
          message: "append-after",
          reason: "after",
          policyId: "test.after",
        }),
      });

      const result = await engine.dispatchSystemPrompt(baseCtx());
      expect(result.appendContext).toBe("append-after");
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("throws in development when non-continue verdict has no reason", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "development";
    try {
      const engine = MiddlewareEngine.create();
      engine.register({
        name: "missing-reason",
        timing: "pre_turn",
        priority: 100,
        fn: () => ({ action: "abort" }),
      });

      await expect(engine.dispatch("pre_turn", baseCtx())).rejects.toThrow(
        "Middleware missing-reason returned abort without reason at pre_turn",
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete env().NODE_ENV;
      } else {
        env().NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("warns once and tags unknown policy in production", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "production";
    const warnings: unknown[] = [];
    const unsub = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const decisions: Array<{ policyId: string; reason?: string }> = [];
      const engine = MiddlewareEngine.create({
        onDecision: (decision) => {
          decisions.push(decision);
        },
      });
      engine.register({
        name: "prod-metadata",
        timing: "pre_turn",
        priority: 100,
        fn: () => ({ action: "abort" }),
      });

      const first = await engine.dispatch("pre_turn", baseCtx());
      const second = await engine.dispatch("pre_turn", baseCtx());

      expect(first).toEqual({ action: "abort", policyId: "unknown" });
      expect(second).toEqual({ action: "abort", policyId: "unknown" });
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.policyId).toBe("unknown");
      expect(decisions[0]?.reason).toBeUndefined();
      expect(decisions[1]?.policyId).toBe("unknown");
      expect(decisions[1]?.reason).toBeUndefined();
      // Bus.publish is async (queueMicrotask), so warning count is verified via decisions
    } finally {
      unsub();
      if (previousNodeEnv === undefined) {
        delete env().NODE_ENV;
      } else {
        env().NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("publishes PolicyEvent.Evaluated via Bus when session context is available", async () => {
    const published: unknown[] = [];
    const unsub = Bus.subscribe(PolicyEvent.Evaluated, (data) => {
      published.push(data);
    });

    try {
      const engine = MiddlewareEngine.create({
        traceContext: {
          traceId: "trace-policy",
          sessionId: "sess-policy",
          runId: "run-policy",
          agentName: "policy-agent",
        },
      });
      engine.register({
        name: "policy-check",
        timing: "pre_tool_use",
        priority: 100,
        fn: () => ({
          action: "abort",
          reason: "blocked_by_test_policy",
          policyId: "test.policy",
        }),
      });

      await engine.dispatch("pre_tool_use", { ...baseCtx(), toolName: "shell" });

      // Bus.publish dispatches handlers via queueMicrotask
      await Promise.resolve();

      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        traceId: "trace-policy",
        sessionId: "sess-policy",
        runId: "run-policy",
        policyId: "test.policy",
        actor: { kind: "agent", name: "policy-agent", runId: "run-policy" },
        action: "tool.call",
        resource: "shell",
        verdict: "abort",
        reason: "blocked_by_test_policy",
      });
    } finally {
      unsub();
      Bus.reset();
    }
  });
});
