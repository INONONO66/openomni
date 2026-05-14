import { describe, expect, it, mock } from "bun:test";
import { PolicyEvent } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Operational } from "@openomni/protocol";
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

function env(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
}

describe("PolicyEngine", () => {
  it("executes policy in priority order (ascending)", async () => {
    const order: number[] = [];
    const engine = PolicyEngine.create();
    engine.register({
      name: "third",
      timing: "turn.start",
      priority: 300,
      fn: () => {
        order.push(300);
        return { action: "continue" } as const;
      },
    });
    engine.register({
      name: "first",
      timing: "turn.start",
      priority: 100,
      fn: () => {
        order.push(100);
        return { action: "continue" } as const;
      },
    });
    engine.register({
      name: "second",
      timing: "turn.start",
      priority: 200,
      fn: () => {
        order.push(200);
        return { action: "continue" } as const;
      },
    });

    await engine.dispatch("turn.start", baseCtx());
    expect(order).toEqual([100, 200, 300]);
  });

  it("only runs policy matching the dispatch timing", async () => {
    const engine = PolicyEngine.create();
    const postFn = mock(() => ({ action: "continue" }) as const);
    const preFn = mock(() => ({ action: "continue" }) as const);
    engine.register({ name: "post", timing: "turn.finish", priority: 100, fn: postFn });
    engine.register({ name: "pre", timing: "turn.start", priority: 100, fn: preFn });

    await engine.dispatch("turn.start", baseCtx());

    expect(preFn).toHaveBeenCalledTimes(1);
    expect(postFn).toHaveBeenCalledTimes(0);
  });

  it("short-circuits on non-continue verdict", async () => {
    const engine = PolicyEngine.create();
    const third = mock(() => ({ action: "continue" }) as const);
    engine.register({
      name: "a",
      timing: "turn.start",
      priority: 100,
      fn: () => ({ action: "continue" }) as const,
    });
    engine.register({
      name: "b",
      timing: "turn.start",
      priority: 200,
      fn: () => ({ action: "abort", reason: "stop" }) as const,
    });
    engine.register({ name: "c", timing: "turn.start", priority: 300, fn: third });

    const verdict = await engine.dispatch("turn.start", baseCtx());
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
      const engine = PolicyEngine.create();
      const after = mock(() => ({ action: "continue" }) as const);
      engine.register({
        name: "boom",
        timing: "turn.start",
        priority: 100,
        fn: () => {
          throw new Error("boom");
        },
      });
      engine.register({ name: "after", timing: "turn.start", priority: 200, fn: after });

      const verdict = await engine.dispatch("turn.start", baseCtx());
      expect(verdict).toEqual({ action: "continue" });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("fail-closed aborts chain on thrown error", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => ({ action: "continue" }) as const);
    engine.register({
      name: "boom",
      timing: "turn.start",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw new Error("boom");
      },
    });
    engine.register({ name: "after", timing: "turn.start", priority: 200, fn: after });

    const verdict = await engine.dispatch("turn.start", baseCtx());
    expect(verdict).toEqual({ action: "abort", reason: "middleware-error" });
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("skips policy when agentType not in scope.agentType", async () => {
    const engine = PolicyEngine.create();
    const scoped = mock(() => ({ action: "continue" }) as const);
    const unscoped = mock(() => ({ action: "continue" }) as const);
    engine.register({
      name: "scoped",
      timing: "turn.start",
      priority: 100,
      scope: { agentType: ["subagent"] },
      fn: scoped,
    });
    engine.register({ name: "unscoped", timing: "turn.start", priority: 200, fn: unscoped });

    await engine.dispatch("turn.start", { ...baseCtx(), agentType: "primary" });

    expect(scoped).toHaveBeenCalledTimes(0);
    expect(unscoped).toHaveBeenCalledTimes(1);
  });

  it("returns continue when no policy registered", async () => {
    const engine = PolicyEngine.create();
    const verdict = await engine.dispatch("turn.start", baseCtx());
    expect(verdict).toEqual({ action: "continue" });
  });

  it("runs policy at multiple timings when timing is an array", async () => {
    const engine = PolicyEngine.create();
    const fn = mock(() => ({ action: "continue" }) as const);
    engine.register({
      name: "multi",
      timing: ["turn.start", "turn.finish"],
      priority: 100,
      fn,
    });

    await engine.dispatch("turn.start", baseCtx());
    await engine.dispatch("turn.finish", baseCtx());
    await engine.dispatch("error", baseCtx());

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dispatchSystemPrompt merges systemPrompt (first wins) and concatenates contexts", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "prompt-a",
      timing: "context.prepare",
      priority: 100,
      fn: () =>
        ({
          action: "transform",
          input: { systemPrompt: "PROMPT_A", appendContext: "append-a" },
          reason: "prompt-a",
          policyId: "test.prompt-a",
        }) as const,
    });
    engine.register({
      name: "prompt-b",
      timing: "context.prepare",
      priority: 200,
      fn: () =>
        ({
          action: "transform",
          input: {
            systemPrompt: "PROMPT_B",
            prependContext: "prepend-b",
            appendContext: "append-b",
          },
          reason: "prompt-b",
          policyId: "test.prompt-b",
        }) as const,
    });
    engine.register({
      name: "inject-c",
      timing: "context.prepare",
      priority: 300,
      fn: () =>
        ({
          action: "inject",
          message: "append-c",
          reason: "inject-c",
          policyId: "test.inject-c",
        }) as const,
    });

    const result = await engine.dispatchSystemPrompt(baseCtx());
    expect(result.systemPrompt).toBe("PROMPT_A");
    expect(result.prependContext).toBe("prepend-b");
    expect(result.appendContext).toBe("append-a\n\nappend-b\n\nappend-c");
  });

  it("dispatchSystemPrompt propagates fail-closed errors", async () => {
    const engine = PolicyEngine.create();
    const testError = new Error("system-prompt-error");
    engine.register({
      name: "boom",
      timing: "context.prepare",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw testError;
      },
    });
    engine.register({
      name: "after",
      timing: "context.prepare",
      priority: 200,
      fn: () =>
        ({
          action: "inject",
          message: "should-not-run",
          reason: "after",
          policyId: "test.after",
        }) as const,
    });

    let thrown: unknown;
    try {
      await engine.dispatchSystemPrompt(baseCtx());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(testError);
  });

  it("dispatchSystemPrompt isolates fail-open errors and continues", async () => {
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    globalObj.console.warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create();
      engine.register({
        name: "boom",
        timing: "context.prepare",
        priority: 100,
        failPolicy: "fail-open",
        fn: () => {
          throw new Error("fail-open-error");
        },
      });
      engine.register({
        name: "after",
        timing: "context.prepare",
        priority: 200,
        fn: () =>
          ({
            action: "inject",
            message: "append-after",
            reason: "after",
            policyId: "test.after",
          }) as const,
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
      const engine = PolicyEngine.create();
      engine.register({
        name: "missing-reason",
        timing: "turn.start",
        priority: 100,
        fn: () => ({ action: "abort" }) as const,
      });

      let thrown: unknown;
      try {
        await engine.dispatch("turn.start", baseCtx());
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain(
        "Middleware missing-reason returned abort without reason at turn.start",
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
      const engine = PolicyEngine.create({
        onDecision: (decision) => {
          decisions.push(decision);
        },
      });
      engine.register({
        name: "prod-metadata",
        timing: "turn.finish",
        priority: 100,
        fn: () => ({ action: "abort" }) as const,
      });

      const first = await engine.dispatch("turn.finish", baseCtx());
      const second = await engine.dispatch("turn.finish", baseCtx());

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
      const engine = PolicyEngine.create({
        traceContext: {
          traceId: "trace-policy",
          sessionId: "sess-policy",
          runId: "run-policy",
          agentName: "policy-agent",
        },
      });
      engine.register({
        name: "policy-check",
        timing: "invoke.prepare",
        priority: 100,
        fn: () =>
          ({
            action: "abort",
            reason: "blocked_by_test_policy",
            policyId: "test.policy",
          }) as const,
      });

      await engine.dispatch("invoke.prepare", { ...baseCtx(), toolName: "shell" });

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

  it("deny-wins: any deny policy aborts regardless of other effects", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "allow-and-label",
      timing: "turn.start",
      priority: 0,
      fn: () => ({ action: "continue", reason: "allowed" }),
    });
    engine.register({
      name: "deny-policy",
      timing: "turn.start",
      priority: 10,
      fn: () => ({ action: "deny", reason: "forbidden" }),
    });
    const verdict = await engine.dispatch("turn.start", baseCtx());
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toBe("forbidden");
  });

  it("scope filtering: only matching agentType policies execute", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    engine.register({
      name: "coder-policy",
      timing: "turn.start",
      priority: 0,
      scope: { agentType: ["coder"] },
      fn: () => {
        executed.push("coder");
        return { action: "continue" };
      },
    });
    engine.register({
      name: "reviewer-policy",
      timing: "turn.start",
      priority: 0,
      scope: { agentType: ["reviewer"] },
      fn: () => {
        executed.push("reviewer");
        return { action: "continue" };
      },
    });
    engine.register({
      name: "unscoped-policy",
      timing: "turn.start",
      priority: 0,
      fn: () => {
        executed.push("unscoped");
        return { action: "continue" };
      },
    });

    await engine.dispatch("turn.start", { ...baseCtx(), agentType: "coder" });
    expect(executed).toEqual(["coder", "unscoped"]);
  });
});
