import { describe, expect, it, mock } from "bun:test";
import type { Hook } from "@openomni/protocol";
import { fromConfig, fromExecutionHooks, fromStepGuard } from "../../../src/core/middleware/compat";
import type { MiddlewareContext } from "../../../src/core/middleware";
import type { ExecutionHooks, AgentStep } from "../../../src/core/types";

function baseCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
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

describe("fromExecutionHooks", () => {
  it("maps preToolUse to pre_tool_use with fail-open", () => {
    const hooks: ExecutionHooks = { preToolUse: () => ({ action: "continue" }) };
    const regs = fromExecutionHooks(hooks);
    expect(regs).toHaveLength(1);
    expect(regs[0].timing).toBe("pre_tool_use");
    expect(regs[0].priority).toBe(250);
    expect(regs[0].failPolicy).toBe("fail-open");
    expect(regs[0].name).toBe("compat:preToolUse");
  });

  it("maps postTurn to post_turn with default fail policy", () => {
    const hooks: ExecutionHooks = { postTurn: () => ({ action: "continue" }) };
    const regs = fromExecutionHooks(hooks);
    expect(regs).toHaveLength(1);
    expect(regs[0].timing).toBe("post_turn");
    expect(regs[0].priority).toBe(250);
    expect(regs[0].failPolicy).toBeUndefined();
  });

  it("maps preTurn to pre_turn", () => {
    const hooks: ExecutionHooks = { preTurn: () => ({ action: "continue" }) };
    const regs = fromExecutionHooks(hooks);
    expect(regs[0].timing).toBe("pre_turn");
    expect(regs[0].priority).toBe(250);
  });

  it("maps postToolUse to post_tool_use", () => {
    const hooks: ExecutionHooks = { postToolUse: () => ({ action: "continue" }) };
    const regs = fromExecutionHooks(hooks);
    expect(regs[0].timing).toBe("post_tool_use");
    expect(regs[0].priority).toBe(250);
  });

  it("maps onError to on_error", () => {
    const hooks: ExecutionHooks = { onError: () => ({ action: "continue" }) };
    const regs = fromExecutionHooks(hooks);
    expect(regs[0].timing).toBe("on_error");
    expect(regs[0].priority).toBe(250);
  });

  it("registers multiple hooks at once", () => {
    const hooks: ExecutionHooks = {
      preToolUse: () => ({ action: "continue" }),
      postTurn: () => ({ action: "continue" }),
      onError: () => ({ action: "continue" }),
    };
    const regs = fromExecutionHooks(hooks);
    expect(regs).toHaveLength(3);
    expect(regs.map((r) => r.timing).sort()).toEqual(["on_error", "post_turn", "pre_tool_use"]);
  });

  it("forwards inject verdict from underlying hook", async () => {
    const hooks: ExecutionHooks = {
      postTurn: () => ({ action: "inject", message: "try again" }),
    };
    const [reg] = fromExecutionHooks(hooks);
    const verdict = await reg.fn(baseCtx());
    expect(verdict).toEqual({ action: "inject", message: "try again" });
  });

  it("returns continue when non-preToolUse hook throws", async () => {
    const hooks: ExecutionHooks = {
      postTurn: () => {
        throw new Error("boom");
      },
    };
    const [reg] = fromExecutionHooks(hooks);
    const verdict = await reg.fn(baseCtx());
    expect(verdict).toEqual({ action: "continue" });
  });

  it("preToolUse errors propagate to engine for fail-open handling", async () => {
    const hooks: ExecutionHooks = {
      preToolUse: () => {
        throw new Error("denied");
      },
    };
    const [reg] = fromExecutionHooks(hooks);
    expect(reg.failPolicy).toBe("fail-open");
    await expect(reg.fn(baseCtx({ timing: "pre_tool_use" }))).rejects.toThrow("denied");
  });

  it("passes HookContext fields correctly from MiddlewareContext", async () => {
    const received: unknown[] = [];
    const hooks: ExecutionHooks = {
      postToolUse: (ctx) => {
        received.push(ctx);
        return { action: "continue" };
      },
    };
    const [reg] = fromExecutionHooks(hooks);
    await reg.fn(
      baseCtx({
        timing: "post_tool_use",
        toolName: "read",
        toolCallId: "tc1",
        toolInput: { path: "/tmp" },
        toolOutput: "content",
        turnCount: 3,
        elapsedMs: 100,
      }),
    );
    expect(received[0]).toMatchObject({
      toolName: "read",
      toolCallId: "tc1",
      input: { path: "/tmp" },
      output: "content",
      turnCount: 3,
      elapsedMs: 100,
    });
  });

  it("onError skips when no Error in ctx", async () => {
    const fn = mock(() => ({ action: "continue" }) as Hook.Verdict);
    const hooks: ExecutionHooks = { onError: fn };
    const [reg] = fromExecutionHooks(hooks);
    const verdict = await reg.fn(baseCtx({ timing: "on_error" }));
    expect(verdict).toEqual({ action: "continue" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("onError invokes hook when Error present in toolInput.error", async () => {
    const captured: Array<{ error: Error }> = [];
    const hooks: ExecutionHooks = {
      onError: (ctx) => {
        captured.push({ error: ctx.error });
        return { action: "continue" };
      },
    };
    const [reg] = fromExecutionHooks(hooks);
    const err = new Error("kaboom");
    await reg.fn(baseCtx({ timing: "on_error", toolInput: { error: err } }));
    expect(captured[0].error).toBe(err);
  });
});

describe("fromStepGuard", () => {
  it("maps stepGuard to post_turn with priority 250", () => {
    const reg = fromStepGuard(() => ({ action: "continue" }));
    expect(reg.timing).toBe("post_turn");
    expect(reg.priority).toBe(250);
    expect(reg.name).toBe("compat:stepGuard");
  });

  it("passes last step and StepGuardContext to guard", async () => {
    const step: AgentStep = { type: "text", content: "hello" };
    const calls: Array<[AgentStep, unknown]> = [];
    const reg = fromStepGuard((s, ctx) => {
      calls.push([s, ctx]);
      return { action: "continue" };
    });
    await reg.fn(
      baseCtx({
        steps: [step],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        turnCount: 2,
        isCompletion: true,
        continuationCount: 1,
        elapsedMs: 500,
      }),
    );
    expect(calls[0][0]).toBe(step);
    expect(calls[0][1]).toEqual({
      steps: [step],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      turnCount: 2,
      isCompletion: true,
      continuationCount: 1,
      elapsedMs: 500,
    });
  });

  it("returns continue when no steps available", async () => {
    const guard = mock(() => ({ action: "continue" }) as Hook.Verdict);
    const reg = fromStepGuard(guard);
    const verdict = await reg.fn(baseCtx({ steps: [] }));
    expect(verdict).toEqual({ action: "continue" });
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("fromConfig", () => {
  it("warns and skips stepGuard when both postTurn and stepGuard set", () => {
    const regs = fromConfig({
      hooks: { postTurn: () => ({ action: "continue" }) },
      stepGuard: () => ({ action: "continue" }),
    });
    expect(regs).toHaveLength(1);
    expect(regs[0].name).toBe("compat:postTurn");
  });

  it("registers stepGuard when postTurn not set", () => {
    const regs = fromConfig({
      hooks: { preToolUse: () => ({ action: "continue" }) },
      stepGuard: () => ({ action: "continue" }),
    });
    expect(regs).toHaveLength(2);
    expect(regs.map((r) => r.name).sort()).toEqual(["compat:preToolUse", "compat:stepGuard"]);
  });

  it("returns empty when neither hooks nor stepGuard set", () => {
    expect(fromConfig({})).toEqual([]);
  });
});
