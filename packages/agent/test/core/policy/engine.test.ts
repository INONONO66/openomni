import { describe, expect, it, mock } from "bun:test";
import { atPoint, registerAt } from "../../helpers/policy-decision";
import { PolicyDecision, Policy } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
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

/** Required inputs for the run.turn.pre / prompt.context.pre point contracts. */
function turnPreCtx() {
  return { ...baseCtx(), sessionId: "session", runId: "run", turnIndex: 0 };
}

/** Required inputs for the run.turn.post point contract. */
function turnPostCtx() {
  return {
    ...baseCtx(),
    sessionId: "session",
    runId: "run",
    turnIndex: 0,
    turnResult: { type: "stop" },
  };
}

/** Required inputs for the tool.native.pre point contract. */
function toolPreCtx() {
  return {
    ...baseCtx(),
    sessionId: "session",
    runId: "run",
    toolId: "tool:native:test",
    toolInput: {},
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
    registerAt(engine, "run.turn.pre", "third", 300, () => {
      order.push(300);
      return PolicyDecision.allow({ policyId: "test.allow" });
    });
    registerAt(engine, "run.turn.pre", "first", 100, () => {
      order.push(100);
      return PolicyDecision.allow({ policyId: "test.allow" });
    });
    registerAt(engine, "run.turn.pre", "second", 200, () => {
      order.push(200);
      return PolicyDecision.allow({ policyId: "test.allow" });
    });

    await engine.dispatchPoint("run.turn.pre", turnPreCtx());
    expect(order).toEqual([100, 200, 300]);
  });

  it("only runs policy registered at the dispatched point", async () => {
    const engine = PolicyEngine.create();
    const postFn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    const preFn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "run.turn.post", "post", 100, postFn);
    registerAt(engine, "run.turn.pre", "pre", 100, preFn);

    await engine.dispatchPoint("run.turn.pre", turnPreCtx());

    expect(preFn).toHaveBeenCalledTimes(1);
    expect(postFn).toHaveBeenCalledTimes(0);
  });

  it("short-circuits on non-continue verdict", async () => {
    const engine = PolicyEngine.create();
    const third = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "run.turn.pre", "a", 100, () =>
      PolicyDecision.allow({ policyId: "test.allow" }),
    );
    registerAt(
      engine,
      "run.turn.pre",
      "b",
      200,
      () =>
        PolicyDecision.deny({
          policyId: "test.abort",
          reasonCodes: ["stop"],
          effects: [{ type: "run.abort", reason: "stop" }],
        }),
      ["run.abort"],
    );
    registerAt(engine, "run.turn.pre", "c", 300, third);

    const verdict = await engine.dispatchPoint("run.turn.pre", turnPreCtx());
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
      engine.register(
        atPoint("run.turn.pre", {
          name: "boom",
          priority: 100,
          failPolicy: "fail-open",
          fn: () => {
            throw new Error("boom");
          },
        }),
      );
      engine.register(
        atPoint("run.turn.pre", {
          name: "after",
          priority: 200,
          fn: after,
        }),
      );

      const verdict = await engine.dispatchPoint("run.turn.pre", turnPreCtx());
      expect(verdict.verdict).toBe("allow");
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("fail-closed aborts chain on thrown error", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "run.turn.pre", {
      name: "boom",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw new Error("boom");
      },
    });
    registerAt(engine, "run.turn.pre", "after", 200, after);

    const verdict = await engine.dispatchPoint("run.turn.pre", turnPreCtx());
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("middleware-error");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("uses resolved policy point default fail-closed for pre-boundary errors", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "tool.native.pre", "boom", 100, () => {
      throw new Error("boom");
    });
    registerAt(engine, "tool.native.pre", "after", 200, after);

    const verdict = await engine.dispatchPoint("tool.native.pre", toolPreCtx());

    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("middleware-error");
    expect(verdict.effects).toContainEqual({ type: "run.abort", reason: "middleware-error" });
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("uses resolved policy point default fail-open for post-boundary errors", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "run.turn.post", "boom", 100, () => {
      throw new Error("boom");
    });
    registerAt(engine, "run.turn.post", "after", 200, after);

    const verdict = await engine.dispatchPoint("run.turn.post", turnPostCtx());

    expect(verdict.verdict).toBe("allow");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("skips policy when agentType not in scope.agentType", async () => {
    const engine = PolicyEngine.create();
    const scoped = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    const unscoped = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    registerAt(engine, "run.turn.pre", {
      name: "scoped",
      priority: 100,
      scope: { agentType: ["worker"] },
      fn: scoped,
    });
    registerAt(engine, "run.turn.pre", "unscoped", 200, unscoped);

    await engine.dispatchPoint("run.turn.pre", { ...turnPreCtx(), agentType: "primary" });

    expect(scoped).toHaveBeenCalledTimes(0);
    expect(unscoped).toHaveBeenCalledTimes(1);
  });

  it("runs policy at multiple points when pointIds is an array", async () => {
    const engine = PolicyEngine.create();
    const fn = mock(() => PolicyDecision.allow({ policyId: "test.allow" }));
    engine.register({
      kind: "point",
      name: "multi",
      pointIds: ["run.turn.pre", "run.turn.post"],
      effectCapabilities: { "run.turn.pre": [], "run.turn.post": [] },
      priority: 100,
      fn,
    });

    await engine.dispatchPoint("run.turn.pre", turnPreCtx());
    await engine.dispatchPoint("run.turn.post", turnPostCtx());
    await engine.dispatchPoint("run.error.error", {
      ...baseCtx(),
      sessionId: "session",
      runId: "run",
      errorCode: "boom",
      errorPhase: "turn",
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rejects non-canonical policy decision shapes fail-closed", async () => {
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "tool.native.pre",
      "legacy-shape",
      0,
      () => ({ action: "abort", reason: "legacy abort", policyId: "legacy" }) as never,
    );

    const result = await engine.dispatchPoint("tool.native.pre", toolPreCtx());

    expect(result.verdict).toBe("deny");
    expect(result.reasonCodes).toContain("policy.invalid_decision");
    expect(result.effects).toContainEqual({ type: "run.abort", reason: "policy.invalid_decision" });
  });

  it("dispatchPoint merges prompt effects at prompt.context.pre", async () => {
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "prompt.context.pre",
      "prompt-a",
      100,
      () =>
        PolicyDecision.allow({
          policyId: "test.prompt-a",
          reasonCodes: ["prompt-a"],
          effects: [
            { type: "prompt.replace", prompt: "PROMPT_A" },
            { type: "prompt.append_context", context: "append-a" },
          ],
        }),
      ["prompt.replace", "prompt.append_context"],
    );
    registerAt(
      engine,
      "prompt.context.pre",
      "prompt-b",
      200,
      () =>
        PolicyDecision.allow({
          policyId: "test.prompt-b",
          reasonCodes: ["prompt-b"],
          effects: [{ type: "prompt.append_context", context: "append-b" }],
        }),
      ["prompt.append_context"],
    );
    registerAt(
      engine,
      "prompt.context.pre",
      "inject-c",
      300,
      () =>
        PolicyDecision.allow({
          policyId: "test.inject-c",
          reasonCodes: ["inject-c"],
          effects: [{ type: "prompt.inject_message", message: "append-c" }],
        }),
      ["prompt.inject_message"],
    );

    const result = await engine.dispatchPoint("prompt.context.pre", turnPreCtx());
    expect(result.verdict).toBe("allow");
    expect(result.effects).toContainEqual({ type: "prompt.replace", prompt: "PROMPT_A" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-a" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-b" });
    expect(result.effects).toContainEqual({ type: "prompt.inject_message", message: "append-c" });
  });

  it("prompt.context.pre fail-closed errors become deny decisions", async () => {
    const engine = PolicyEngine.create();
    const testError = new Error("system-prompt-error");
    registerAt(engine, "prompt.context.pre", {
      name: "boom",
      priority: 100,
      failPolicy: "fail-closed",
      fn: () => {
        throw testError;
      },
    });
    registerAt(
      engine,
      "prompt.context.pre",
      "after",
      200,
      () =>
        PolicyDecision.allow({
          policyId: "test.after",
          reasonCodes: ["after"],
          effects: [{ type: "prompt.inject_message", message: "should-not-run" }],
        }),
      ["prompt.inject_message"],
    );

    const decision = await engine.dispatchPoint("prompt.context.pre", turnPreCtx());
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("middleware-error");
  });

  it("prompt.context.pre isolates fail-open errors and continues", async () => {
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    globalObj.console.warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create();
      engine.register(
        atPoint("prompt.context.pre", {
          name: "boom",
          priority: 100,
          failPolicy: "fail-open",
          fn: () => {
            throw new Error("fail-open-error");
          },
        }),
      );
      engine.register(
        atPoint("prompt.context.pre", {
          name: "after",
          effects: ["prompt.inject_message"],
          priority: 200,
          fn: () =>
            PolicyDecision.allow({
              policyId: "test.after",
              reasonCodes: ["after"],
              effects: [{ type: "prompt.inject_message", message: "append-after" }],
            }),
        }),
      );

      const result = await engine.dispatchPoint("prompt.context.pre", turnPreCtx());
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
      engine.register(
        atPoint("run.turn.pre", {
          name: "missing-reason",
          priority: 100,
          fn: () => PolicyDecision.deny({ policyId: "unknown" }),
        }),
      );

      const decision = await engine.dispatchPoint("run.turn.pre", turnPreCtx());
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
    const unsub = Bus.subscribe(Operational.Events.Warn, (data) => warnings.push(data));
    try {
      const decisions: Array<{ policyId: string; reasonCodes: string[] }> = [];
      const engine = PolicyEngine.create({
        onDecision: (decision) => {
          decisions.push(decision);
        },
      });
      engine.register(
        atPoint("run.turn.post", {
          name: "prod-metadata",
          priority: 100,
          fn: () => PolicyDecision.deny({ policyId: "unknown" }),
        }),
      );

      const first = await engine.dispatchPoint("run.turn.post", turnPostCtx());
      const second = await engine.dispatchPoint("run.turn.post", turnPostCtx());

      expect(first.verdict).toBe("deny");
      expect(second.verdict).toBe("deny");
      expect(decisions).toHaveLength(2);
      // policyId is re-attributed to the invoked registration at the trust
      // boundary; a middleware's self-reported id is not trusted.
      expect(decisions[0]?.policyId).toBe("prod-metadata");
      expect(decisions[0]?.reasonCodes).toEqual([]);
      expect(decisions[1]?.policyId).toBe("prod-metadata");
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
    const unsub = Bus.subscribe(Operational.Events.Warn, (data) => warnings.push(data));
    try {
      const engine = PolicyEngine.create({
        onDecision: () => {
          throw new Error("observer failed");
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("run.turn.post", {
          name: "observer-isolation",
          priority: 100,
          fn: () => PolicyDecision.allow({ policyId: "observer-isolation" }),
        }),
      );

      const decision = await engine.dispatchPoint("run.turn.post", {
        ...turnPostCtx(),
        traceContext: { traceId: "trace-observer", sessionId: "session-observer", runId: "run-1" },
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
    const unsub = Bus.subscribe(Operational.Events.Warn, (data) => warnings.push(data));
    try {
      const engine = PolicyEngine.create({
        // The publisher reports under the engine's trace or not at all, so an
        // engine that emits audit has to be given one.
        traceContext: { traceId: "trace-observer-isolation", sessionId: "session-1" },
        onDecision: async () => {
          throw new Error("async observer failed");
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("run.turn.post", {
          name: "async-observer-isolation",
          priority: 100,
          fn: () => PolicyDecision.allow({ policyId: "async-observer-isolation" }),
        }),
      );

      const decision = await engine.dispatchPoint("run.turn.post", turnPostCtx());
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
    registerAt(engine, "run.turn.post", "observer-latency-isolation", 100, () =>
      PolicyDecision.allow({ policyId: "observer-latency-isolation" }),
    );

    const decision = await engine.dispatchPoint("run.turn.post", turnPostCtx());

    expect(decision.verdict).toBe("allow");
    expect(observerStarted).toBe(true);
    releaseObserver?.();
  });

  it("publishes Policy.Events.Evaluated via Bus when session context is available", async () => {
    const published: unknown[] = [];
    const unsub = Bus.subscribe(Policy.Events.Evaluated, (data) => {
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
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("tool.native.pre", {
          name: "policy-check",
          effects: ["run.abort"],
          priority: 100,
          fn: () =>
            PolicyDecision.deny({
              policyId: "test.policy",
              reasonCodes: ["blocked_by_test_policy"],
              effects: [{ type: "run.abort", reason: "blocked_by_test_policy" }],
            }),
        }),
      );

      await engine.dispatchPoint("tool.native.pre", { ...toolPreCtx(), toolName: "shell" });

      // Bus.publish dispatches handlers via queueMicrotask
      await Promise.resolve();

      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        traceId: "trace-policy",
        sessionId: "sess-policy",
        runId: "run-policy",
        // Attributed to the invoked registration, not the middleware's
        // self-reported "test.policy" id.
        policyId: "policy-check",
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
    registerAt(engine, "run.turn.pre", "allow-and-label", 0, () =>
      PolicyDecision.allow({ policyId: "test.allow", reasonCodes: ["allowed"] }),
    );
    registerAt(
      engine,
      "run.turn.pre",
      "deny-policy",
      10,
      () =>
        PolicyDecision.deny({
          policyId: "test.deny",
          reasonCodes: ["forbidden"],
          effects: [{ type: "run.abort", reason: "forbidden" }],
        }),
      ["run.abort"],
    );
    const verdict = await engine.dispatchPoint("run.turn.pre", turnPreCtx());
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("forbidden");
  });

  it("scope filtering: only matching agentType policies execute", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    registerAt(engine, "run.turn.pre", {
      name: "coder-policy",
      priority: 0,
      scope: { agentType: ["coder"] },
      fn: () => {
        executed.push("coder");
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    registerAt(engine, "run.turn.pre", {
      name: "reviewer-policy",
      priority: 0,
      scope: { agentType: ["reviewer"] },
      fn: () => {
        executed.push("reviewer");
        return PolicyDecision.allow({ policyId: "test.allow" });
      },
    });
    registerAt(engine, "run.turn.pre", "unscoped-policy", 0, () => {
      executed.push("unscoped");
      return PolicyDecision.allow({ policyId: "test.allow" });
    });

    await engine.dispatchPoint("run.turn.pre", { ...turnPreCtx(), agentType: "coder" });
    expect(executed).toEqual(["coder", "unscoped"]);
  });
});
