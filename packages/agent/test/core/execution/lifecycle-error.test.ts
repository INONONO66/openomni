import { describe, expect, it, mock } from "bun:test";
import { RunEvents } from "../../../src/core/execution/events";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { registerAt, abortRun, allow } from "../../helpers/policy-decision";
import { handleError } from "../../../src/core/execution/turn";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("handleError (error)", () => {
  it("dispatches error and respects abort verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => abortRun("test.error-abort", "error-abort"));
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.error.error", {
      name: "test-on-error",
      effects: ["run.abort"],
      priority: 100,
      fn,
    });

    const state = makeState();
    const config = makeConfig();
    const error = new Error("test-failure");
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const decision = await handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      error,
      1,
      retryPolicy,
    );

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext;
    expect(ctx.timing).toBe("error");
    expect(ctx.toolInput?.error).toMatchObject({ name: "Error", message: error.message });

    expect(decision.action).toBe("complete");
    if (decision.action !== "complete") throw new Error("expected a settled result");
    expect(decision.result.guardAborted).toBe(true);
  });

  it("error continue verdict allows retry when retry policy permits", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.error.error", "test-on-error-continue", 100, () => allow());

    const state = makeState();
    const config = makeConfig();
    const error = new Error("timeout while waiting");
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const decision = await handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      error,
      1,
      retryPolicy,
    );
    expect(decision.action).toBe("retry");
  });

  /**
   * The wait itself is the runner's since #632; what `handleError` decides is
   * how long. `run-terminal-record.test.ts` covers what an abort during that
   * wait records.
   */
  it("reports the run.retry_after delay as the backoff", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.error.error",
      "test-on-error-retry-delay",
      100,
      () => allow("test.retry-delay", "retry-after", [{ type: "run.retry_after", delayMs: 20 }]),
      ["run.retry_after"],
    );

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const decision = await handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      1,
      retryPolicy,
    );

    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") throw new Error("expected a retry decision");
    // 20 from the effect, not the 0 the policy configured.
    expect(decision.backoffMs).toBe(20);
  });

  it("applies run.retry_after maxRetries as a stricter retry ceiling", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.error.error",
      "test-on-error-retry-limit",
      100,
      () =>
        allow("test.retry-limit", "retry-after", [
          { type: "run.retry_after", delayMs: 0, maxRetries: 1 },
        ]),
      ["run.retry_after"],
    );

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const decision = await handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      2,
      retryPolicy,
    );

    expect(decision.action).toBe("throw");
  });

  /**
   * `classifyRetryReason` and `shouldRetry` used to narrate every branch to
   * the Bus under a freshly minted trace. They are pure now, so the reason and
   * the backoff have to reach the one correlated event or the information is
   * lost — this is what holds them there.
   */
  it("reports the retry reason and backoff on the run's own trace", async () => {
    const retries: Array<Record<string, unknown>> = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, (event) => {
      retries.push(event as unknown as Record<string, unknown>);
    });
    const engine = PolicyEngine.create({ clock: Date.now });
    const agentBase = makeAgentBase();

    try {
      await handleError(
        makeState(),
        engine,
        makeConfig(),
        agentBase,
        new Error("connection timeout"),
        1,
        // Non-zero: an assertion of `0` also holds when the field is
        // hardcoded to 0, which is what the first version of this test did.
        { maxAttempts: 3, backoffMs: { initial: 50, multiplier: 2, max: 1000 } },
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      reason: "timeout",
      backoffMs: 50,
      attempt: 1,
    });
  });

  /**
   * A first-attempt terminal failure has no preceding `ErrorRetry`, so this is
   * the only record of why the run stopped — and the effective `maxAttempts`,
   * after a `run.retry_after` effect narrows the configured one, exists
   * nowhere else at all.
   */
  /**
   * `handleError` reports the facts; the runner records them (#632), so this
   * asserts the report rather than the event. The record itself, and that a
   * throw always produces one, is `run-terminal-record.test.ts`.
   */
  it("reports the decision on the terminal failure, with the narrowed ceiling", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.error.error",
      "narrow-retries",
      10,
      () =>
        allow("narrow-retries", undefined, [
          { type: "run.retry_after", delayMs: 0, maxRetries: 1 },
        ]),
      ["run.retry_after"],
    );
    const decision = await handleError(
      makeState(),
      engine,
      makeConfig(),
      makeAgentBase(),
      new Error("schema validation failed"),
      // Not 1: `attempt` is a pass-through, and asserting it at its input
      // value of 1 also holds when the field is hardcoded to 1.
      2,
      { maxAttempts: 5, backoffMs: { initial: 0, multiplier: 1, max: 0 } },
    );

    expect(decision.action).toBe("throw");
    if (decision.action !== "throw") throw new Error("expected a terminal decision");
    expect(decision.failure).toEqual({
      reason: "validation_error",
      attempt: 2,
      // 1 from the effect, not the 5 the policy configured.
      maxAttempts: 1,
    });
  });

  /**
   * The retry path reports the same narrowed ceiling as the terminal one. It
   * was pinned only on the terminal side, so a run configured for five
   * attempts and narrowed to two could still report five on every retry.
   */
  it("reports the narrowed ceiling on the retry path too", async () => {
    const retries: Array<{ maxAttempts: number }> = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, (event) => {
      retries.push(event as unknown as { maxAttempts: number });
    });
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.error.error",
      "narrow-retries",
      10,
      () =>
        allow("narrow-retries", undefined, [
          { type: "run.retry_after", delayMs: 0, maxRetries: 2 },
        ]),
      ["run.retry_after"],
    );

    try {
      await handleError(
        makeState(),
        engine,
        makeConfig(),
        makeAgentBase(),
        new Error("connection timeout"),
        1,
        { maxAttempts: 5, backoffMs: { initial: 0, multiplier: 1, max: 0 } },
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(retries).toHaveLength(1);
    // 2 from the effect, not the 5 the policy configured.
    expect(retries[0]?.maxAttempts).toBe(2);
  });
});
