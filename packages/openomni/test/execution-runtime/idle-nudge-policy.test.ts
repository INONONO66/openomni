import { afterEach, describe, expect, it } from "bun:test";
import { createIdleNudgePolicy } from "../../src/execution-runtime/middleware/idle-nudge-policy";
import type { PolicyContext, PolicyFn } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";

const originalNow = Date.now;

function mockNow(ms: number): void {
  Date.now = () => ms;
}

function baseCtx(
  timing: Policy.Timing,
  pointId: Parameters<PolicyFn>[0]["pointId"],
  overrides?: Partial<PolicyContext>,
): Parameters<PolicyFn>[0] {
  return {
    timing,
    pointId,
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
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(verdict.verdict).toBe("allow");
  });

  it("injects nudge message when idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
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
    expect(injectedMessage(await mw.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    mockNow(4000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    mockNow(6000);
    const third = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(third.verdict).toBe("deny");
    expect(third.reasonCodes).toContain("stalled");
  });

  it("invoke.result resets idle timer", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });

    // Pinned on this call, not the next one. By 65s the run is already past
    // the threshold, so without the reset branch this call nudges — and the
    // nudge path sets `lastProgressAt` too, leaving the following turn
    // indistinguishable either way.
    mockNow(65000);
    const progress = await mw.fn(baseCtx("invoke.result", "tool.native.post"));
    expect(injectedMessage(progress)).toBeUndefined();

    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(verdict.verdict).toBe("allow");
    expect(injectedMessage(verdict)).toBeUndefined();
  });

  it("is disabled when idleThresholdMs is -1", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: -1 });
    mockNow(999999);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(verdict.verdict).toBe("allow");
  });

  it("respects custom idleThresholdMs and maxNudges", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 5000, maxNudges: 1 });

    mockNow(3000);
    expect((await mw.fn(baseCtx("turn.start", "run.turn.pre"))).verdict).toBe("allow");

    mockNow(10000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    mockNow(20000);
    const next = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(next.verdict).toBe("deny");
    expect(next.reasonCodes).toContain("stalled");
  });

  it("nudge message reports idle duration in seconds", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 10000 });
    mockNow(125500);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    const message = injectedMessage(verdict);
    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("126s");
  });

  it("registers canonical turn and tool-result points with priority 300", () => {
    const mw = createIdleNudgePolicy();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.priority).toBe(300);
    expect(mw.kind).toBe("point");
    expect(mw.pointIds).toEqual(["run.turn.pre", "tool.native.post", "tool.mcp.post"]);
  });
});
