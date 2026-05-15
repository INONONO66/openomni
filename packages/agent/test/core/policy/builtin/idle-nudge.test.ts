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

function injectedMessage(verdict: Policy.PolicyDecision): string | undefined {
  return verdict.effects.find((effect) => effect.type === "prompt.inject_message")?.message;
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
    expect(verdict.verdict).toBe("allow");
  });

  it("injects nudge message when idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start"));
    const message = injectedMessage(verdict);
    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("[System]");
    expect(message).toContain("idle for 69s");
    expect(message).toContain("Report your current status");
  });

  it("aborts with 'stalled' after maxNudges exceeded", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 });

    mockNow(2000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start")))).toBeDefined();

    mockNow(4000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start")))).toBeDefined();

    mockNow(6000);
    const third = await mw.fn(baseCtx("turn.start"));
    expect(third.verdict).toBe("deny");
    expect(third.reasonCodes).toContain("stalled");
  });

  it("invoke.result resets idle timer", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });

    mockNow(65000);
    await mw.fn(baseCtx("invoke.result"));

    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.verdict).toBe("allow");
  });

  it("is disabled when idleThresholdMs is -1", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: -1 });
    mockNow(999999);
    const verdict = await mw.fn(baseCtx("turn.start"));
    expect(verdict.verdict).toBe("allow");
  });

  it("respects custom idleThresholdMs and maxNudges", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 5000, maxNudges: 1 });

    mockNow(3000);
    expect((await mw.fn(baseCtx("turn.start"))).verdict).toBe("allow");

    mockNow(10000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start")))).toBeDefined();

    mockNow(20000);
    const next = await mw.fn(baseCtx("turn.start"));
    expect(next.verdict).toBe("deny");
    expect(next.reasonCodes).toContain("stalled");
  });

  it("nudge message reports idle duration in seconds", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 10000 });
    mockNow(125500);
    const verdict = await mw.fn(baseCtx("turn.start"));
    const message = injectedMessage(verdict);
    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("126s");
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
