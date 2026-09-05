import { describe, expect, it } from "bun:test";
import { RunEvents } from "../../../src/core/execution/events";
import { handleError } from "../../../src/core/execution/turn";
import { Bus } from "../../../src/index";
import { runInput } from "../../helpers/run-input";

const base = runInput([{ role: "user", content: "hello" }]).traceContext;
const agentBase = {
  traceId: base.traceId,
  sessionId: base.sessionId,
  runId: base.runId,
  actorId: base.runId,
};
const config = { events: Bus, model: { provider: "test", id: "model" } };
const retryPolicy = {
  maxAttempts: 3,
  backoffMs: { initial: 50, multiplier: 2, max: 75 },
};

describe("retry and terminal error decisions", () => {
  it("classifies timeout and reports the exact retry facts", async () => {
    const event = Promise.withResolvers<{ reason: string; backoffMs: number; attempt: number; maxAttempts: number }>();
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, event.resolve);
    try {
      const decision = await handleError(config, agentBase, new Error("connection timeout"), 1, retryPolicy);
      expect(decision).toEqual({
        action: "retry",
        backoffMs: 50,
        failure: { reason: "timeout", attempt: 1, maxAttempts: 3 },
      });
      expect(await event.promise).toMatchObject({
        reason: "timeout",
        backoffMs: 50,
        attempt: 1,
        maxAttempts: 3,
      });
    } finally {
      unsubscribe();
    }
  });

  it("caps exponential backoff at the configured maximum", async () => {
    const decision = await handleError(config, agentBase, new Error("tool failed"), 2, retryPolicy);
    expect(decision).toMatchObject({ action: "retry", backoffMs: 75 });
  });

  it("returns the terminal classified facts at the retry ceiling", async () => {
    const error = new Error("schema validation failed");
    const decision = await handleError(config, agentBase, error, 3, retryPolicy);
    expect(decision).toEqual({
      action: "throw",
      error,
      failure: { reason: "validation_error", attempt: 3, maxAttempts: 3 },
    });
  });

  it("never retries a typed abort", async () => {
    const error = new Error("operator stop");
    error.name = "AbortError";
    expect(await handleError(config, agentBase, error, 1, retryPolicy)).toEqual({
      action: "throw",
      error,
      failure: { reason: "aborted", attempt: 1, maxAttempts: 3 },
    });
  });
});
