import { expect, test } from "bun:test";
import { LlmCall, Operational } from "@openomni/protocol";
import { Retry, observeRetry } from "../../../src/model";
import { apiError, sdkError, sources, FIXED_RETRY_NOW } from "../helpers/retry";
import { collector } from "../helpers/observation";

const identity = {
  traceId: "trace",
  sessionId: "session",
  runId: "run",
  provider: "anthropic",
  attempt: 1,
  maxAttempts: 3,
};
for (const message of [
  "rate limit",
  JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }),
]) {
  test(`canonical retry telemetry for ${message}`, () => {
    const error = apiError({
      message,
      isRetryable: true,
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "1" },
    });
    const decision = Retry.decide(1, error, sources());
    expect(decision).toEqual({ retry: true, reason: "rate_limit", delayMs: 1 });
    if (!decision.retry) throw new Error("expected retry");
    const events = collector();
    observeRetry(events, { ...identity, decision, now: () => FIXED_RETRY_NOW });
    expect(events.named(LlmCall.Events.RetryDecided.name)).toMatchObject([
      {
        attempt: 1,
        maxAttempts: 3,
        reason: "rate_limit",
        backoffMs: 1,
        runId: "run",
        time: FIXED_RETRY_NOW,
      },
    ]);
    expect(events.named(LlmCall.Events.RateLimited.name)).toMatchObject([
      { provider: "anthropic", retryAfterMs: 1, time: FIXED_RETRY_NOW },
    ]);
  });
}

test("explicit over-cap directive declines; inferred reset demotes and publishes its selected delay", () => {
  const explicit = apiError({
    message: "limit",
    isRetryable: true,
    statusCode: 429,
    responseHeaders: { "retry-after": "3600" },
  });
  expect(Retry.decide(1, explicit, sources())).toMatchObject({ retry: false, reason: "rate_limit" });
  const inferred = apiError({
    message: "limit",
    isRetryable: true,
    statusCode: 429,
    responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
  });
  const decision = Retry.decide(1, inferred, sources());
  expect(decision).toMatchObject({ retry: true, retryAfterOverCap: true });
  if (!decision.retry) throw new Error("expected retry");
  const events = collector();
  observeRetry(events, { ...identity, decision, now: () => FIXED_RETRY_NOW });
  expect(events.named(Operational.Events.Warn.name)).toMatchObject([
    { context: { backoffMs: decision.delayMs }, time: FIXED_RETRY_NOW },
  ]);
});

test("raw and wrapped transport failures use short probes and terminate on the third instant failure", () => {
  const error = sdkError({ message: "connection refused", isRetryable: true });
  const wrapped = new Error("provider call failed", { cause: error });
  expect(Retry.isInstantTransportFailure(wrapped, 1)).toBe(true);
  expect([1, 2].map((attempt) => Retry.decide(attempt, wrapped, sources(), attempt))).toEqual([
    { retry: true, reason: "server_error", delayMs: 250 },
    { retry: true, reason: "server_error", delayMs: 250 },
  ]);
  expect(Retry.decide(3, wrapped, sources(), 3)).toMatchObject({ retry: false, reason: "server_error" });
  expect(Retry.isInstantTransportFailure(wrapped, 2000)).toBe(false);
});
