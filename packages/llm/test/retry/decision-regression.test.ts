import { expect, test } from "bun:test";
import { LlmCall, Operational } from "@openomni/protocol";
import { Retry, observeRetry } from "../../src";
import { APIError } from "../../src/error";
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
    const error = new APIError({
      message,
      isRetryable: true,
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "1" },
    });
    const decision = Retry.decide(1, error);
    expect(decision).toEqual({ retry: true, reason: "rate_limit", delayMs: 1 });
    if (!decision.retry) throw new Error("expected retry");
    const events = collector();
    observeRetry(events, { ...identity, decision });
    expect(events.named(LlmCall.Events.RetryDecided.name)).toMatchObject([
      { attempt: 1, maxAttempts: 3, reason: "rate_limit", backoffMs: 1, runId: "run" },
    ]);
    expect(events.named(LlmCall.Events.RateLimited.name)).toMatchObject([
      { provider: "anthropic", retryAfterMs: 1 },
    ]);
  });
}

test("explicit over-cap directive declines; inferred reset demotes and publishes its selected delay", () => {
  const explicit = new APIError({
    message: "limit",
    isRetryable: true,
    statusCode: 429,
    responseHeaders: { "retry-after": "3600" },
  });
  expect(Retry.decide(1, explicit)).toMatchObject({ retry: false, reason: "rate_limit" });
  const inferred = new APIError({
    message: "limit",
    isRetryable: true,
    statusCode: 429,
    responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
  });
  const decision = Retry.decide(1, inferred);
  expect(decision).toMatchObject({ retry: true, retryAfterOverCap: true });
  if (!decision.retry) throw new Error("expected retry");
  const events = collector();
  observeRetry(events, { ...identity, decision });
  expect(events.named(Operational.Events.Warn.name)).toMatchObject([
    { context: { backoffMs: decision.delayMs } },
  ]);
});

test("raw and wrapped transport failures use short probes and terminate on the third instant failure", () => {
  const error = Object.assign(new Error("connection refused"), {
    name: "AI_APICallError",
    isRetryable: true,
  });
  const wrapped = new Error("provider call failed", { cause: error });
  expect(Retry.isInstantTransportFailure(wrapped, 1)).toBe(true);
  expect([1, 2].map((attempt) => Retry.decide(attempt, wrapped, attempt))).toEqual([
    { retry: true, reason: "server_error", delayMs: 250 },
    { retry: true, reason: "server_error", delayMs: 250 },
  ]);
  expect(Retry.decide(3, wrapped, 3)).toMatchObject({ retry: false, reason: "server_error" });
  expect(Retry.isInstantTransportFailure(wrapped, 2000)).toBe(false);
});
