import { afterEach, describe, expect, it } from "bun:test";
import { createIdleNudgePolicy } from "../../../../src/core/policy/builtin/idle-nudge";
import type { PolicyContext } from "../../../../src/core/policy";
import type { Policy } from "@openomni/protocol";

const originalNow = Date.now;

function mockNow(ms: number): void {
  Date.now = () => ms;
}

function baseCtx(timing: Policy.Timing, overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

afterEach(() => {
  Date.now = originalNow;
});

describe("createIdleNudgePolicy", () => {
  it("continues when activity is recent (not idle)", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(30000);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.action).toBe("continue");
  });

  it("injects nudge message when idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.message).toContain("[System]");
      expect(verdict.message).toContain("idle for 69s");
      expect(verdict.message).toContain("Report your current status");
    }
  });

  it("aborts with 'stalled' after maxNudges exceeded", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 });

    mockNow(2000);
    expect((await mw.fn(baseCtx("turn.start"))).action).toBe("inject");

    mockNow(4000);
    expect((await mw.fn(baseCtx("turn.start"))).action).toBe("inject");

    mockNow(6000);
    const third = await mw.fn(baseCtx("turn.start"));
    expect(third.action).toBe("abort");
    if (third.action === "abort") {
      expect(third.reason).toBe("stalled");
    }
  });

  it("invoke.result resets idle timer", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });

    mockNow(65000);
    await mw.fn(baseCtx("invoke.result"));

    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.action).toBe("continue");
  });

  it("is disabled when idleThresholdMs is -1", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: -1 });
    mockNow(999999);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.action).toBe("continue");
  });

  it("respects custom idleThresholdMs and maxNudges", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 5000, maxNudges: 1 });

    mockNow(3000);
    expect((await mw.fn(baseCtx("turn.start"))).action).toBe("continue");

    mockNow(10000);
    expect((await mw.fn(baseCtx("turn.start"))).action).toBe("inject");

    mockNow(20000);
    const next = await mw.fn(baseCtx("turn.start"));
    expect(next.action).toBe("abort");
    if (next.action === "abort") expect(next.reason).toBe("stalled");
  });

  it("nudge message reports idle duration in seconds", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 10000 });
    mockNow(125500);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.message).toContain("126s");
    }
  });

  it("registers for both turn.start and invoke.result timings with priority 300", () => {
    const mw = createIdleNudgePolicy();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.priority).toBe(300);
    expect(Array.isArray(mw.timing)).toBe(true);
    expect(mw.timing).toContain("turn.start");
    expect(mw.timing).toContain("invoke.result");
  });
});
