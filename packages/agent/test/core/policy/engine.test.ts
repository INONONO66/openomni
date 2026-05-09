import { describe, expect, it, mock } from "bun:test";
import type { Guardrail, ExecutionEvent } from "@openomni/protocol";
import { EventLog, Log, SqliteStorageAdapter, Storage } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext, PolicyDecision } from "../../../src/core/policy";

function baseCtx(): Omit<PolicyContext, "timing"> {
  return {};
}

function env(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
}

async function expectRejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`Expected promise to reject with ${message}`);
}

describe("PolicyEngine", () => {
  it("returns continue when no policies are registered", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict).toEqual({ action: "continue" });
  });

  it("executes policies in priority order (ascending)", async () => {
    const order: number[] = [];
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "third",
      timing: "pre_turn",
      priority: 300,
      fn: () => {
        order.push(300);
        return { action: "continue", reason: "ok", policyId: "p.third" };
      },
    });
    engine.register({
      name: "first",
      timing: "pre_turn",
      priority: 100,
      fn: () => {
        order.push(100);
        return { action: "continue", reason: "ok", policyId: "p.first" };
      },
    });
    engine.register({
      name: "second",
      timing: "pre_turn",
      priority: 200,
      fn: () => {
        order.push(200);
        return { action: "continue", reason: "ok", policyId: "p.second" };
      },
    });

    await engine.dispatch("pre_turn", baseCtx());
    expect(order).toEqual([100, 200, 300]);
  });

  it("short-circuits on first non-continue verdict", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const third = mock(() => ({
      action: "continue" as const,
      reason: "ok",
      policyId: "p.third",
    }));
    engine.register({
      name: "a",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "continue", reason: "ok", policyId: "p.a" }),
    });
    engine.register({
      name: "b",
      timing: "pre_turn",
      priority: 200,
      fn: () => ({ action: "abort", reason: "blocked", policyId: "p.b" }),
    });
    engine.register({ name: "c", timing: "pre_turn", priority: 300, fn: third });

    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict.action).toBe("abort");
    expect(third).toHaveBeenCalledTimes(0);
  });

  it("skip verdict stops the chain", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const after = mock(() => ({
      action: "continue" as const,
      reason: "ok",
      policyId: "p.after",
    }));
    engine.register({
      name: "skipper",
      timing: "pre_tool_use",
      priority: 100,
      fn: () => ({ action: "skip", reason: "not allowed", policyId: "p.skipper" }),
    });
    engine.register({ name: "after", timing: "pre_tool_use", priority: 200, fn: after });

    const verdict = await engine.dispatch("pre_tool_use", baseCtx());
    expect(verdict.action).toBe("skip");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("retry verdict stops the chain", async () => {
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "retrier",
      timing: "on_error",
      priority: 100,
      fn: () => ({ action: "retry", reason: "transient", policyId: "p.retrier" }),
    });

    const verdict = await engine.dispatch("on_error", baseCtx());
    expect(verdict.action).toBe("retry");
  });

  it("fail-open: policy error is swallowed and chain continues", async () => {
    const originalWarn = Log.warn;
    (Log as unknown as { warn: typeof Log.warn }).warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create({ audit: false });
      const after = mock(() => ({
        action: "continue" as const,
        reason: "ok",
        policyId: "p.after",
      }));
      engine.register({
        name: "boom",
        timing: "pre_turn",
        priority: 100,
        fn: () => {
          throw new Error("kaboom");
        },
      });
      engine.register({ name: "after", timing: "pre_turn", priority: 200, fn: after });

      const verdict = await engine.dispatch("pre_turn", baseCtx());
      expect(verdict).toEqual({ action: "continue" });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      (Log as unknown as { warn: typeof Log.warn }).warn = originalWarn;
    }
  });

  it("fail-closed: policy error aborts immediately", async () => {
    const originalWarn = Log.warn;
    (Log as unknown as { warn: typeof Log.warn }).warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create({ audit: false });
      const after = mock(() => ({
        action: "continue" as const,
        reason: "ok",
        policyId: "p.after",
      }));
      engine.register({
        name: "boom",
        timing: "pre_turn",
        priority: 100,
        failPolicy: "fail-closed",
        fn: () => {
          throw new Error("kaboom");
        },
      });
      engine.register({ name: "after", timing: "pre_turn", priority: 200, fn: after });

      const verdict = await engine.dispatch("pre_turn", baseCtx());
      expect(verdict.action).toBe("abort");
      expect(after).toHaveBeenCalledTimes(0);
    } finally {
      (Log as unknown as { warn: typeof Log.warn }).warn = originalWarn;
    }
  });

  it("scope filtering: only runs policies matching agentType", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const scoped = mock(() => ({
      action: "continue" as const,
      reason: "ok",
      policyId: "p.scoped",
    }));
    const unscoped = mock(() => ({
      action: "continue" as const,
      reason: "ok",
      policyId: "p.unscoped",
    }));
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

  it("scope filtering: runs scoped policy when agentType matches", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const scoped = mock(() => ({
      action: "continue" as const,
      reason: "ok",
      policyId: "p.scoped",
    }));
    engine.register({
      name: "scoped",
      timing: "pre_turn",
      priority: 100,
      scope: { agentType: ["subagent", "reviewer"] },
      fn: scoped,
    });

    await engine.dispatch("pre_turn", { ...baseCtx(), agentType: "reviewer" });
    expect(scoped).toHaveBeenCalledTimes(1);
  });

  it("freeze prevents further registration", () => {
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "pre-freeze",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "continue", reason: "ok", policyId: "p.pre" }),
    });
    engine.freeze();

    expect(() =>
      engine.register({
        name: "post-freeze",
        timing: "pre_turn",
        priority: 200,
        fn: () => ({ action: "continue", reason: "ok", policyId: "p.post" }),
      }),
    ).toThrow("PolicyEngine is frozen");
  });

  it("deriveChildPolicies returns only propagated registrations as clones", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const fnA = () => ({ action: "continue" as const, reason: "ok", policyId: "p.a" });
    const fnB = () => ({ action: "continue" as const, reason: "ok", policyId: "p.b" });

    engine.register({
      name: "propagated",
      timing: "pre_turn",
      priority: 100,
      propagate: true,
      scope: { agentType: ["subagent"] },
      fn: fnA,
    });
    engine.register({
      name: "local-only",
      timing: "pre_turn",
      priority: 200,
      fn: fnB,
    });

    const children = engine.deriveChildPolicies();
    expect(children).toHaveLength(1);
    expect(children[0]!.name).toBe("propagated");
    expect(children[0]!.fn).toBe(fnA);

    children[0]!.scope!.agentType!.push("mutant");
    const children2 = engine.deriveChildPolicies();
    expect(children2[0]!.scope!.agentType).toEqual(["subagent"]);
  });

  it("dispatchSystemPrompt composes transform and inject verdicts", async () => {
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "prompt-a",
      timing: "on_system_prompt",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { systemPrompt: "BASE_PROMPT", appendContext: "ctx-a" },
        reason: "prompt-a",
        policyId: "p.prompt-a",
      }),
    });
    engine.register({
      name: "prompt-b",
      timing: "on_system_prompt",
      priority: 200,
      fn: () => ({
        action: "transform",
        input: { systemPrompt: "IGNORED", prependContext: "pre-b", appendContext: "ctx-b" },
        reason: "prompt-b",
        policyId: "p.prompt-b",
      }),
    });
    engine.register({
      name: "injector",
      timing: "on_system_prompt",
      priority: 300,
      fn: () => ({
        action: "inject",
        message: "injected-msg",
        reason: "injector",
        policyId: "p.injector",
      }),
    });

    const result = await engine.dispatchSystemPrompt(baseCtx());
    expect(result.systemPrompt).toBe("BASE_PROMPT");
    expect(result.prependContext).toBe("pre-b");
    expect(result.appendContext).toBe("ctx-a\n\nctx-b\n\ninjected-msg");
  });

  it("dispatchSystemPrompt returns empty object when no transforms", async () => {
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "noop",
      timing: "on_system_prompt",
      priority: 100,
      fn: () => ({ action: "continue", reason: "pass", policyId: "p.noop" }),
    });

    const result = await engine.dispatchSystemPrompt(baseCtx());
    expect(result).toEqual({});
  });

  it("onDecision callback receives correct decision metadata", async () => {
    const decisions: PolicyDecision[] = [];
    const engine = PolicyEngine.create({
      audit: false,
      onDecision: (d) => {
        decisions.push(d);
      },
    });
    engine.register({
      name: "test-policy",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "abort", reason: "blocked", policyId: "test.block" }),
    });

    await engine.dispatch("pre_turn", baseCtx());

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.timing).toBe("pre_turn");
    expect(decisions[0]!.label).toBe("test-policy");
    expect(decisions[0]!.policyId).toBe("test.block");
    expect(decisions[0]!.verdict.action).toBe("abort");
    expect(decisions[0]!.reason).toBe("blocked");
    expect(typeof decisions[0]!.durationMs).toBe("number");
  });

  it("onDecision fires for every policy in chain (not just terminal)", async () => {
    const decisions: PolicyDecision[] = [];
    const engine = PolicyEngine.create({
      audit: false,
      onDecision: (d) => {
        decisions.push(d);
      },
    });
    engine.register({
      name: "first",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "continue", policyId: "p.first" }),
    });
    engine.register({
      name: "second",
      timing: "pre_turn",
      priority: 200,
      fn: () => ({ action: "abort", reason: "stop", policyId: "p.second" }),
    });

    await engine.dispatch("pre_turn", baseCtx());
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.label).toBe("first");
    expect(decisions[1]!.label).toBe("second");
  });

  it("runs policy at multiple timings when timing is an array", async () => {
    const engine = PolicyEngine.create({ audit: false });
    const fn = mock(() => ({ action: "continue" as const, reason: "ok", policyId: "p.multi" }));
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

  it("throws in dev when non-continue verdict lacks reason", async () => {
    const prev = env().NODE_ENV;
    env().NODE_ENV = "development";
    try {
      const engine = PolicyEngine.create({ audit: false });
      engine.register({
        name: "no-reason",
        timing: "pre_turn",
        priority: 100,
        fn: () => ({ action: "abort" }),
      });

      await expectRejectsWith(
        engine.dispatch("pre_turn", baseCtx()),
        "Policy no-reason returned abort without reason at pre_turn",
      );
    } finally {
      if (prev === undefined) delete env().NODE_ENV;
      else env().NODE_ENV = prev;
    }
  });

  it("tags unknown policyId in production and warns once", async () => {
    const prev = env().NODE_ENV;
    env().NODE_ENV = "production";
    const originalWarn = Log.warn;
    const warnSpy = mock(() => undefined);
    (Log as unknown as { warn: typeof Log.warn }).warn = warnSpy;
    try {
      const decisions: PolicyDecision[] = [];
      const engine = PolicyEngine.create({
        audit: false,
        onDecision: (d) => {
          decisions.push(d);
        },
      });
      engine.register({
        name: "prod-no-meta",
        timing: "pre_turn",
        priority: 100,
        fn: () => ({ action: "abort" }),
      });

      const v1 = await engine.dispatch("pre_turn", baseCtx());
      const v2 = await engine.dispatch("pre_turn", baseCtx());

      expect(v1).toEqual({ action: "abort", policyId: "unknown" });
      expect(v2).toEqual({ action: "abort", policyId: "unknown" });
      // warns only once per unique timing+label
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      (Log as unknown as { warn: typeof Log.warn }).warn = originalWarn;
      if (prev === undefined) delete env().NODE_ENV;
      else env().NODE_ENV = prev;
    }
  });

  describe("evaluatePermission", () => {
    const engine = PolicyEngine.create({ audit: false });

    it("returns allow when permission is undefined (default allow)", () => {
      const result = engine.evaluatePermission(undefined, {
        action: "tool.call",
        resource: "shell",
      });
      expect(result.action).toBe("continue");
      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("default_allow");
    });

    it("returns a result assignable to the legacy Guardrail evaluation result", () => {
      const result: Guardrail.EvaluationResult = engine.evaluatePermission(undefined, {
        action: "tool.call",
        resource: "shell",
      });

      expect(result.policyId).toBe("guardrail.permission");
    });

    it("evaluates representative permission inputs correctly", () => {
      const permission = {
        action: "tool.call",
        allowlist: ["safe.*"],
        denylist: ["safe.blocked"],
        requireApproval: ["safe.review"],
        inputRules: [
          {
            toolPattern: "safe.*",
            field: "text",
            pattern: "secret",
            action: "deny" as const,
            priority: 10,
          },
        ],
      };

      const allowed = engine.evaluatePermission(permission, {
        action: "tool.call",
        resource: "safe.echo",
        input: { text: "hello" },
      });
      expect(allowed.decision).toBe("allow");
      expect(allowed.reason).toBe("allowlist");

      const inputDenied = engine.evaluatePermission(permission, {
        action: "tool.call",
        resource: "safe.echo",
        input: { text: "secret" },
      });
      expect(inputDenied.decision).toBe("deny");

      const denylistBlocked = engine.evaluatePermission(permission, {
        action: "tool.call",
        resource: "safe.blocked",
        input: {},
      });
      expect(denylistBlocked.decision).toBe("deny");
      expect(denylistBlocked.reason).toBe("denylist");

      const approvalRequired = engine.evaluatePermission(permission, {
        action: "tool.call",
        resource: "safe.review",
        input: {},
      });
      expect(approvalRequired.decision).toBe("require_approval");

      const actionMismatch = engine.evaluatePermission(permission, {
        action: "other",
        resource: "safe.echo",
        input: {},
      });
      expect(actionMismatch.decision).toBe("deny");
      expect(actionMismatch.reason).toBe("action_mismatch");
    });

    it("returns deny when action does not match permission action", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call" },
        { action: "file.write", resource: "shell" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("action_mismatch");
    });

    it("allows resource in allowlist", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", allowlist: ["shell", "grep"] },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("continue");
      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("allowlist");
      expect(result.matchedPattern).toBe("shell");
    });

    it("denies resource in denylist even when in allowlist", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", allowlist: ["shell", "grep"], denylist: ["shell"] },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("denylist");
    });

    it("returns require_approval for matching requireApproval pattern", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", requireApproval: ["shell"] },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("require_approval");
      expect(result.reason).toBe("require_approval");
    });

    it("denies resource not in allowlist (allowlist_miss)", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", allowlist: ["grep", "find"] },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("allowlist_miss");
    });

    it("denies when allowlist is empty", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", allowlist: [] },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("allowlist_empty");
    });

    it("allows by default when no lists defined", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call" },
        { action: "tool.call", resource: "shell" },
      );
      expect(result.action).toBe("continue");
      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("default_allow");
    });

    it("matches wildcard patterns in allowlist", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", allowlist: ["*"] },
        { action: "tool.call", resource: "anything" },
      );
      expect(result.action).toBe("continue");
      expect(result.decision).toBe("allow");
      expect(result.matchedPattern).toBe("*");
    });

    it("matches prefix wildcard in denylist (e.g. fs.*)", () => {
      const result = engine.evaluatePermission(
        { action: "tool.call", denylist: ["fs.*"] },
        { action: "tool.call", resource: "fs.write" },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.matchedPattern).toBe("fs.*");
    });

    it("inputRules take precedence over deny/allow lists", () => {
      const result = engine.evaluatePermission(
        {
          action: "tool.call",
          allowlist: ["shell"],
          inputRules: [
            {
              toolPattern: "shell",
              field: "command",
              pattern: "rm\\s+-rf",
              action: "deny",
              reason: "dangerous_command",
              priority: 0,
            },
          ],
        },
        { action: "tool.call", resource: "shell", input: { command: "rm -rf /" } },
      );
      expect(result.action).toBe("abort");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("dangerous_command");
    });

    it("inputRules respect priority order (higher first)", () => {
      const result = engine.evaluatePermission(
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "shell",
              field: "command",
              pattern: ".*",
              action: "deny",
              reason: "catch_all",
              priority: 0,
            },
            {
              toolPattern: "shell",
              field: "command",
              pattern: "echo",
              action: "allow",
              reason: "safe_echo",
              priority: 10,
            },
          ],
        },
        { action: "tool.call", resource: "shell", input: { command: "echo hello" } },
      );
      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("safe_echo");
    });
  });

  it("dispatchSystemPrompt fail-closed rethrows error", async () => {
    const originalWarn = Log.warn;
    (Log as unknown as { warn: typeof Log.warn }).warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create({ audit: false });
      engine.register({
        name: "boom",
        timing: "on_system_prompt",
        priority: 100,
        failPolicy: "fail-closed",
        fn: () => {
          throw new Error("system-prompt-crash");
        },
      });

      await expectRejectsWith(engine.dispatchSystemPrompt(baseCtx()), "system-prompt-crash");
    } finally {
      (Log as unknown as { warn: typeof Log.warn }).warn = originalWarn;
    }
  });

  it("dispatchSystemPrompt fail-open skips errored policy and continues", async () => {
    const originalWarn = Log.warn;
    (Log as unknown as { warn: typeof Log.warn }).warn = mock(() => undefined);
    try {
      const engine = PolicyEngine.create({ audit: false });
      engine.register({
        name: "boom",
        timing: "on_system_prompt",
        priority: 100,
        fn: () => {
          throw new Error("ignored");
        },
      });
      engine.register({
        name: "ok",
        timing: "on_system_prompt",
        priority: 200,
        fn: () => ({
          action: "inject",
          message: "survived",
          reason: "ok",
          policyId: "p.ok",
        }),
      });

      const result = await engine.dispatchSystemPrompt(baseCtx());
      expect(result.appendContext).toBe("survived");
    } finally {
      (Log as unknown as { warn: typeof Log.warn }).warn = originalWarn;
    }
  });

  it("async policy functions are awaited", async () => {
    const engine = PolicyEngine.create({ audit: false });
    engine.register({
      name: "async-policy",
      timing: "pre_turn",
      priority: 100,
      fn: async () => {
        await Promise.resolve().then(() => undefined);
        return { action: "abort", reason: "async-block", policyId: "p.async" };
      },
    });

    const verdict = await engine.dispatch("pre_turn", baseCtx());
    expect(verdict.action).toBe("abort");
  });

  it("freeze returns the engine for chaining", () => {
    const engine = PolicyEngine.create({ audit: false });
    const result = engine.freeze();
    expect(result).toBe(engine);
  });

  it("register returns the engine for chaining", () => {
    const engine = PolicyEngine.create({ audit: false });
    const result = engine.register({
      name: "chain-test",
      timing: "pre_turn",
      priority: 100,
      fn: () => ({ action: "continue", reason: "ok", policyId: "p.chain" }),
    });
    expect(result).toBe(engine);
  });

  it("writes policy decisions to EventLog when session context is available", async () => {
    const adapter = new SqliteStorageAdapter(":memory:");
    Storage.configure(adapter);
    adapter.session.set("sess-policy-engine", {
      id: "sess-policy-engine",
      title: "PolicyEngine session",
      model: { providerID: "test", modelID: "test-model" },
      spawnDepth: 0,
      time: { created: Date.now(), updated: Date.now() },
    });

    try {
      const engine = PolicyEngine.create({
        traceContext: {
          traceId: "trace-policy-engine",
          sessionId: "sess-policy-engine",
          runId: "run-policy-engine",
          agentName: "policy-engine-agent",
        },
      });
      engine.register({
        name: "policy-check",
        timing: "pre_tool_use",
        priority: 100,
        fn: () => ({
          action: "abort",
          reason: "blocked_by_policy_engine",
          policyId: "test.policy-engine",
        }),
      });

      await engine.dispatch("pre_tool_use", { toolName: "shell" });

      const events: ExecutionEvent[] = [];
      for await (const event of EventLog.replay("sess-policy-engine")) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "policy_evaluated",
        policyId: "test.policy-engine",
        actor: { kind: "agent", name: "policy-engine-agent", runId: "run-policy-engine" },
        action: "tool.call",
        resource: "shell",
        verdict: "abort",
        reason: "blocked_by_policy_engine",
        actionId: "sess-policy-engine:policy.pre_tool_use:policy-check:1",
        visibility: "internal",
        sequence: 1,
      });
    } finally {
      Storage.reset();
      adapter.close();
    }
  });
});
