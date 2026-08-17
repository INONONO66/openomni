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
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 }).create();
    mockNow(30000);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(verdict.verdict).toBe("allow");
  });

  it("injects nudge message when idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 }).create();
    mockNow(70000);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    const message = injectedMessage(verdict);
    expect(verdict.verdict).toBe("allow");
    expect(verdict.policyId).toBe("builtin.idle_nudge");
    expect(verdict.reasonCodes).toContain("idle_nudge");
    expect(message).toContain("[System]");
    expect(message).toContain("idle for 69s");
    expect(message).toContain("Report your current status");
  });

  it("nudge message states the real semantics: progress resets, no progress aborts", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 }).create();
    mockNow(2000);
    const message = injectedMessage(await mw.fn(baseCtx("turn.start", "run.turn.pre")));
    // The old text promised that "saying so explicitly" prevented the abort;
    // nothing read the reply. What actually resets the check is observable
    // progress, and the message must say what actually happens.
    expect(message).toContain("Only observable progress");
    expect(message).toContain("aborted as stalled");
    expect(message).not.toContain("say so explicitly");
  });

  it("aborts with 'stalled' after maxNudges exceeded on a turn that never advances", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 }).create();

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
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 }).create();

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

  /**
   * Audit H2 regression: turn completion is progress. A healthy text-only
   * multi-turn run — no tool calls, every turn slower than the threshold —
   * advances `turnCount` at each run.turn.pre, and must never be nudged,
   * let alone aborted as stalled.
   */
  it("does not nudge or abort a text-only multi-turn run with slow turns", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 }).create();

    mockNow(500);
    const first = await mw.fn(baseCtx("turn.start", "run.turn.pre", { turnCount: 0 }));
    expect(first.verdict).toBe("allow");
    expect(injectedMessage(first)).toBeUndefined();

    // Each following turn arrives well past the idle threshold, but the
    // turnCount advance IS the progress: the previous turn completed.
    for (const [at, turnCount] of [
      [3000, 1],
      [6000, 2],
      [9000, 3],
      [12000, 4],
    ] as const) {
      mockNow(at);
      const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre", { turnCount }));
      expect(verdict.verdict).toBe("allow");
      expect(injectedMessage(verdict)).toBeUndefined();
    }
  });

  it("a turn advance also resets the nudge budget", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 1 }).create();

    // Burn the nudge budget on a stuck turn.
    mockNow(2000);
    expect(injectedMessage(await mw.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    // The turn then advances: progress. The next stall starts from zero
    // nudges instead of aborting immediately.
    mockNow(3000);
    const advanced = await mw.fn(baseCtx("turn.start", "run.turn.pre", { turnCount: 1 }));
    expect(advanced.verdict).toBe("allow");

    mockNow(6000);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre", { turnCount: 1 }));
    expect(verdict.verdict).toBe("allow");
    expect(injectedMessage(verdict)).toBeDefined();
  });

  /**
   * Audit H1 regression: the idle clock and nudge counter are run state.
   * One factory shared across runs (and across parent/child agents through a
   * shared middleware array) mints independent state per `create()`.
   */
  it("each create() mints an independent idle clock and nudge budget", async () => {
    mockNow(0);
    const shared = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 1 });
    const runOne = shared.create();

    mockNow(2000);
    expect(injectedMessage(await runOne.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    // A second run starts much later from the SAME factory: its clock starts
    // at creation, and run one's spent nudge budget does not leak into it.
    mockNow(10000);
    const runTwo = shared.create();
    mockNow(10500);
    const fresh = await runTwo.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(fresh.verdict).toBe("allow");
    expect(injectedMessage(fresh)).toBeUndefined();

    mockNow(12000);
    expect(injectedMessage(await runTwo.fn(baseCtx("turn.start", "run.turn.pre")))).toBeDefined();

    // Run one's next stalled check still denies on its own counter,
    // unaffected by run two's activity.
    mockNow(14000);
    const stalled = await runOne.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(stalled.verdict).toBe("deny");
    expect(stalled.reasonCodes).toContain("stalled");
  });

  it("is disabled when idleThresholdMs is -1", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: -1 }).create();
    mockNow(999999);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    expect(verdict.verdict).toBe("allow");
  });

  it("respects custom idleThresholdMs and maxNudges", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 5000, maxNudges: 1 }).create();

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
    const mw = createIdleNudgePolicy({ idleThresholdMs: 10000 }).create();
    mockNow(125500);
    const verdict = await mw.fn(baseCtx("turn.start", "run.turn.pre"));
    const message = injectedMessage(verdict);
    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("126s");
  });

  it("registers canonical turn and tool-result points with priority 300", () => {
    const factory = createIdleNudgePolicy();
    expect(factory.kind).toBe("factory");
    expect(factory.name).toBe("builtin:idle-nudge");
    const mw = factory.create();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.priority).toBe(300);
    expect(mw.kind).toBe("point");
    expect(mw.pointIds).toEqual(["run.turn.pre", "tool.native.post", "tool.mcp.post"]);
    // Not decoration: the engine replaces any effect a registration did not
    // declare for the point it fired at, so losing these two entries would
    // silently drop the nudge and the stalled abort at runtime while every
    // direct `mw.fn(...)` assertion above still passed.
    expect(mw.effectCapabilities).toEqual({
      "run.turn.pre": ["prompt.inject_message", "run.abort"],
      "tool.native.post": [],
      "tool.mcp.post": [],
    });
  });
});
