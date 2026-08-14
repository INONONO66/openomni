import { describe, expect, it, mock } from "bun:test";
import { AgentExecution, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { AgentEvent } from "../../../src/core/types";
import { abortRun, allow } from "../../helpers/policy-decision";
import { handleError } from "../../../src/core/execution/turn-outcome";
import { collectEvents, makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("handleError (error)", () => {
  it("dispatches error and respects abort verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => abortRun("test.error-abort", "error-abort"));
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-on-error",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.abort"] },
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

    const gen = handleError(state, engine, config, makeAgentBase(), error, 1, retryPolicy);
    let result: IteratorResult<AgentEvent, unknown>;
    const events: AgentEvent[] = [];
    do {
      result = await gen.next();
      if (!result.done && result.value) events.push(result.value as AgentEvent);
    } while (!result.done);

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext;
    expect(ctx.timing).toBe("error");
    expect(ctx.toolInput?.error).toMatchObject({ name: "Error", message: error.message });

    const decision = result.value as { action: string };
    expect(decision.action).toBe("complete");
    const completeEvent = events.find((e) => e.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.result.guardAborted).toBe(true);
  });

  it("error continue verdict allows retry when retry policy permits", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-on-error-continue",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": [] },
      priority: 100,
      fn: () => allow(),
    });

    const state = makeState();
    const config = makeConfig();
    const error = new Error("timeout while waiting");
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const gen = handleError(state, engine, config, makeAgentBase(), error, 1, retryPolicy);
    let result: IteratorResult<AgentEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);

    const decision = result.value as { action: string };
    expect(decision.action).toBe("retry");
  });

  it("applies run.retry_after delayMs before retrying", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-on-error-retry-delay",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.retry_after"] },
      priority: 100,
      fn: () =>
        allow("test.retry-delay", "retry-after", [{ type: "run.retry_after", delayMs: 20 }]),
    });

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const started = Date.now();
    const gen = handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      1,
      retryPolicy,
    );
    let result: IteratorResult<AgentEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);

    expect((result.value as { action: string }).action).toBe("retry");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("does not sleep when retry delay is already aborted", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-on-error-aborted-retry-delay",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.retry_after"] },
      priority: 100,
      fn: () =>
        allow("test.aborted-retry-delay", "retry-after", [
          { type: "run.retry_after", delayMs: 5_000 },
        ]),
    });

    const controller = new AbortController();
    controller.abort();
    const state = makeState();
    const config = makeConfig({ signal: controller.signal });
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const started = Date.now();
    const gen = handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      1,
      retryPolicy,
    );
    await gen.next();

    await expect(gen.next()).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("applies run.retry_after maxRetries as a stricter retry ceiling", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-on-error-retry-limit",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.retry_after"] },
      priority: 100,
      fn: () =>
        allow("test.retry-limit", "retry-after", [
          { type: "run.retry_after", delayMs: 0, maxRetries: 1 },
        ]),
    });

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const events = await collectEvents(
      handleError(
        state,
        engine,
        config,
        makeAgentBase(),
        new Error("timeout while waiting"),
        2,
        retryPolicy,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", willRetry: false });
  });

  /**
   * `classifyRetryReason` and `shouldRetry` used to narrate every branch to
   * the Bus under a freshly minted trace. They are pure now, so the reason and
   * the backoff have to reach the one correlated event or the information is
   * lost — this is what holds them there.
   */
  it("reports the retry reason and backoff on the run's own trace", async () => {
    const retries: Array<Record<string, unknown>> = [];
    const unsubscribe = Bus.subscribe(AgentExecution.ErrorRetry, (event) => {
      retries.push(event as unknown as Record<string, unknown>);
    });
    const engine = PolicyEngine.create();
    const agentBase = makeAgentBase();

    try {
      await collectEvents(
        handleError(
          makeState(),
          engine,
          makeConfig(),
          agentBase,
          new Error("connection timeout"),
          1,
          // Non-zero: an assertion of `0` also holds when the field is
          // hardcoded to 0, which is what the first version of this test did.
          { maxAttempts: 3, backoffMs: { initial: 50, multiplier: 2, max: 1000 } },
        ),
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
  it("records the decision on the terminal failure, with the narrowed ceiling", async () => {
    const failures: Array<{
      traceId: string;
      sessionId?: string;
      context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.subscribe(Operational.Error, (event) => {
      failures.push(event as unknown as (typeof failures)[number]);
    });
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "narrow-retries",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.retry_after"] },
      priority: 10,
      fn: () =>
        allow("narrow-retries", undefined, [
          { type: "run.retry_after", delayMs: 0, maxRetries: 1 },
        ]),
    });
    const agentBase = makeAgentBase();

    try {
      await collectEvents(
        handleError(
          makeState(),
          engine,
          makeConfig(),
          agentBase,
          new Error("schema validation failed"),
          // Not 1: `attempt` is a pass-through, and asserting it at its input
          // value of 1 also holds when the field is hardcoded to 1.
          2,
          { maxAttempts: 5, backoffMs: { initial: 0, multiplier: 1, max: 0 } },
        ),
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(failures).toHaveLength(1);
    expect(failures[0]?.traceId).toBe(agentBase.traceId);
    expect(failures[0]?.sessionId).toBe(agentBase.sessionId);
    expect(failures[0]?.context).toEqual({
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
    const unsubscribe = Bus.subscribe(AgentExecution.ErrorRetry, (event) => {
      retries.push(event as unknown as { maxAttempts: number });
    });
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "narrow-retries",
      pointIds: ["run.error.error"],
      effectCapabilities: { "run.error.error": ["run.retry_after"] },
      priority: 10,
      fn: () =>
        allow("narrow-retries", undefined, [
          { type: "run.retry_after", delayMs: 0, maxRetries: 2 },
        ]),
    });

    try {
      await collectEvents(
        handleError(
          makeState(),
          engine,
          makeConfig(),
          makeAgentBase(),
          new Error("connection timeout"),
          1,
          { maxAttempts: 5, backoffMs: { initial: 0, multiplier: 1, max: 0 } },
        ),
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
