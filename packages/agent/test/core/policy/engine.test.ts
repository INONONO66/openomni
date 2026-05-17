import { describe, expect, it, mock } from "bun:test";
import { PolicyDecision, PolicyEvent } from "@openomni/protocol";
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
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    engine.register({
      name: "first",
      timing: "turn.start",
      priority: 100,
      fn: () => {
        order.push(100);
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    engine.register({
      name: "second",
      timing: "turn.start",
      priority: 200,
      fn: () => {
        order.push(200);
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });

    await engine.dispatch("turn.start", baseCtx());
    expect(order).toEqual([100, 200, 300]);
  });

  it("only runs policy matching the dispatch timing", async () => {
    const engine = PolicyEngine.create();
    const postFn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    const preFn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    engine.register({ name: "post", timing: "turn.finish", priority: 100, fn: postFn });
    engine.register({ name: "pre", timing: "turn.start", priority: 100, fn: preFn });

    await engine.dispatch("turn.start", baseCtx());

    expect(preFn).toHaveBeenCalledTimes(1);
    expect(postFn).toHaveBeenCalledTimes(0);
  });

  it("short-circuits on non-continue verdict", async () => {
    const engine = PolicyEngine.create();
    const third = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    engine.register({
      name: "a",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "test.allow" }),
    });
    engine.register({
      name: "b",
      timing: "turn.start",
      priority: 200,
      fn: () =>
        PolicyDecision.deny({
          policyId: "test.abort",
          reasonCodes: ["stop"],
          effects: [{ type: "run.abort", reason: "stop" }],
        }),
    });
    engine.register({ name: "c", timing: "turn.start", priority: 300, fn: third });

    const verdict = await engine.dispatch("turn.start", baseCtx());
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("stop");
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
      const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
      engine.register({
        name: "boom",
        timing: "turn.start",
        priority: 100,
        failPolicy: "fail-open",
        fn: () => {
          throw new Error("boom");
        },
      });
      engine.register({ name: "after", timing: "turn.start", priority: 200, fn: after });

      const verdict = await engine.dispatch("turn.start", baseCtx());
      expect(verdict.verdict).toBe("allow");
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("fail-closed aborts chain on thrown error", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
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
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("middleware-error");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("uses resolved policy point default fail-closed for pre-boundary errors", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    engine.register({
      name: "boom",
      timing: "invoke.prepare",
      priority: 100,
      fn: () => {
        throw new Error("boom");
      },
    });
    engine.register({ name: "after", timing: "invoke.prepare", priority: 200, fn: after });

    const verdict = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      resourceDescriptor: {
        id: "tool:native:test",
        kind: "tool",
        labels: ["source.system"],
        capabilities: ["exec"],
        effects: ["workspace.mutate"],
        source: { type: "system" },
      },
    });

    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("middleware-error");
    expect(verdict.effects).toContainEqual({ type: "run.abort", reason: "middleware-error" });
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("uses resolved policy point default fail-open for post-boundary errors", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    engine.register({
      name: "boom",
      timing: "turn.finish",
      priority: 100,
      fn: () => {
        throw new Error("boom");
      },
    });
    engine.register({ name: "after", timing: "turn.finish", priority: 200, fn: after });

    const verdict = await engine.dispatch("turn.finish", baseCtx());

    expect(verdict.verdict).toBe("allow");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("skips policy when agentType not in scope.agentType", async () => {
    const engine = PolicyEngine.create();
    const scoped = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    const unscoped = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
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
    expect(verdict).toMatchObject({ verdict: "allow", policyId: "agent.policy.composed" });
  });

  it("runs policy at multiple timings when timing is an array", async () => {
    const engine = PolicyEngine.create();
    const fn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
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

  it("rejects non-canonical policy decision shapes fail-closed", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "legacy-shape",
      timing: "invoke.prepare",
      priority: 0,
      fn: () => ({ action: "abort", reason: "legacy abort", policyId: "legacy" }) as never,
    });

    const result = await engine.dispatch("invoke.prepare", baseCtx());

    expect(result.verdict).toBe("deny");
    expect(result.reasonCodes).toContain("policy.invalid_decision");
    expect(result.effects).toContainEqual({ type: "run.abort", reason: "policy.invalid_decision" });
  });

  it("dispatch merges prompt effects at context.prepare", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "prompt-a",
      timing: "context.prepare",
      priority: 100,
      fn: () =>
        PolicyDecision.allow({
          policyId: "test.prompt-a",
          reasonCodes: ["prompt-a"],
          effects: [
            { type: "prompt.replace", prompt: "PROMPT_A" },
            { type: "prompt.append_context", context: "append-a" },
          ],
        }),
    });
    engine.register({
      name: "prompt-b",
      timing: "context.prepare",
      priority: 200,
      fn: () =>
        PolicyDecision.allow({
          policyId: "test.prompt-b",
          reasonCodes: ["prompt-b"],
          effects: [{ type: "prompt.append_context", context: "append-b" }],
        }),
    });
    engine.register({
      name: "inject-c",
      timing: "context.prepare",
      priority: 300,
      fn: () =>
        PolicyDecision.allow({
          policyId: "test.inject-c",
          reasonCodes: ["inject-c"],
          effects: [{ type: "prompt.inject_message", message: "append-c" }],
        }),
    });

    const result = await engine.dispatch("context.prepare", baseCtx());
    expect(result.verdict).toBe("allow");
    expect(result.effects).toContainEqual({ type: "prompt.replace", prompt: "PROMPT_A" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-a" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-b" });
    expect(result.effects).toContainEqual({ type: "prompt.inject_message", message: "append-c" });
  });

  it("context.prepare fail-closed errors become deny decisions", async () => {
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
        PolicyDecision.allow({
          policyId: "test.after",
          reasonCodes: ["after"],
          effects: [{ type: "prompt.inject_message", message: "should-not-run" }],
        }),
    });

    const decision = await engine.dispatch("context.prepare", baseCtx());
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("middleware-error");
  });

  it("context.prepare isolates fail-open errors and continues", async () => {
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
          PolicyDecision.allow({
            policyId: "test.after",
            reasonCodes: ["after"],
            effects: [{ type: "prompt.inject_message", message: "append-after" }],
          }),
      });

      const result = await engine.dispatch("context.prepare", baseCtx());
      expect(result.effects).toContainEqual({
        type: "prompt.inject_message",
        message: "append-after",
      });
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("allows deny decisions with no reason codes", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "development";
    try {
      const engine = PolicyEngine.create();
      engine.register({
        name: "missing-reason",
        timing: "turn.start",
        priority: 100,
        fn: () => PolicyDecision.deny({ policyId: "unknown" }),
      });

      const decision = await engine.dispatch("turn.start", baseCtx());
      expect(decision.verdict).toBe("deny");
      expect(decision.reasonCodes).toEqual([]);
    } finally {
      if (previousNodeEnv === undefined) {
        delete env().NODE_ENV;
      } else {
        env().NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("passes canonical decisions to onDecision", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "production";
    const warnings: unknown[] = [];
    const unsub = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const decisions: Array<{ policyId: string; reasonCodes: string[] }> = [];
      const engine = PolicyEngine.create({
        onDecision: (decision) => {
          decisions.push(decision);
        },
      });
      engine.register({
        name: "prod-metadata",
        timing: "turn.finish",
        priority: 100,
        fn: () => PolicyDecision.deny({ policyId: "unknown" }),
      });

      const first = await engine.dispatch("turn.finish", baseCtx());
      const second = await engine.dispatch("turn.finish", baseCtx());

      expect(first.verdict).toBe("deny");
      expect(second.verdict).toBe("deny");
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.policyId).toBe("unknown");
      expect(decisions[0]?.reasonCodes).toEqual([]);
      expect(decisions[1]?.policyId).toBe("unknown");
      expect(decisions[1]?.reasonCodes).toEqual([]);
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

  it("isolates onDecision observer errors from policy dispatch", async () => {
    Bus.reset();
    const warnings: unknown[] = [];
    const unsub = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const engine = PolicyEngine.create({
        onDecision: () => {
          throw new Error("observer failed");
        },
      });
      engine.register({
        name: "observer-isolation",
        timing: "turn.finish",
        priority: 100,
        fn: () => PolicyDecision.allow({ policyId: "observer-isolation" }),
      });

      const decision = await engine.dispatch("turn.finish", {
        ...baseCtx(),
        traceContext: { traceId: "trace-observer", sessionId: "session-observer" },
      });
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(decision.verdict).toBe("allow");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        traceId: "trace-observer",
        sessionId: "session-observer",
        component: "agent.policy",
        msg: "onDecision observer error",
        context: {
          timing: "turn.finish",
          policyId: "observer-isolation",
          error: "Error: observer failed",
        },
      });
    } finally {
      unsub();
      Bus.reset();
    }
  });

  it("isolates async onDecision observer rejections from policy dispatch", async () => {
    Bus.reset();
    const warnings: unknown[] = [];
    const unsub = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const engine = PolicyEngine.create({
        onDecision: async () => {
          throw new Error("async observer failed");
        },
      });
      engine.register({
        name: "async-observer-isolation",
        timing: "turn.finish",
        priority: 100,
        fn: () => PolicyDecision.allow({ policyId: "async-observer-isolation" }),
      });

      const decision = await engine.dispatch("turn.finish", baseCtx());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(decision.verdict).toBe("allow");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        component: "agent.policy",
        msg: "onDecision observer error",
        context: {
          timing: "turn.finish",
          policyId: "async-observer-isolation",
          error: "Error: async observer failed",
        },
      });
    } finally {
      unsub();
      Bus.reset();
    }
  });

  it("does not wait for async onDecision observers before returning decisions", async () => {
    let observerStarted = false;
    let releaseObserver: (() => void) | undefined;
    const engine = PolicyEngine.create({
      onDecision: async () => {
        observerStarted = true;
        await new Promise<void>((resolve) => {
          releaseObserver = resolve;
        });
      },
    });
    engine.register({
      name: "observer-latency-isolation",
      timing: "turn.finish",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "observer-latency-isolation" }),
    });

    const decision = await engine.dispatch("turn.finish", baseCtx());

    expect(decision.verdict).toBe("allow");
    expect(observerStarted).toBe(true);
    releaseObserver?.();
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
          PolicyDecision.deny({
            policyId: "test.policy",
            reasonCodes: ["blocked_by_test_policy"],
            effects: [{ type: "run.abort", reason: "blocked_by_test_policy" }],
          }),
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
        verdict: "deny",
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
      fn: () => PolicyDecision.allow({ policyId: "test.allow", reasonCodes: ["allowed"] }),
    });
    engine.register({
      name: "deny-policy",
      timing: "turn.start",
      priority: 10,
      fn: () =>
        PolicyDecision.deny({
          policyId: "test.deny",
          reasonCodes: ["forbidden"],
          effects: [{ type: "run.abort", reason: "forbidden" }],
        }),
    });
    const verdict = await engine.dispatch("turn.start", baseCtx());
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("forbidden");
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
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    engine.register({
      name: "reviewer-policy",
      timing: "turn.start",
      priority: 0,
      scope: { agentType: ["reviewer"] },
      fn: () => {
        executed.push("reviewer");
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    engine.register({
      name: "unscoped-policy",
      timing: "turn.start",
      priority: 0,
      fn: () => {
        executed.push("unscoped");
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });

    await engine.dispatch("turn.start", { ...baseCtx(), agentType: "coder" });
    expect(executed).toEqual(["coder", "unscoped"]);
  });
});
