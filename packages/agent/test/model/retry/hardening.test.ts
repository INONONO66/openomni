import { describe, expect, test } from "bun:test";
import { Retry } from "../../../src/model/retry";

import { apiError, rateLimitError, sources, type SdkErrorInput } from "../helpers/retry";

function retryableError(overrides: Partial<SdkErrorInput> = {}) {
  return apiError({ message: "boom", isRetryable: true, ...overrides });
}

function delayOf<E>(attempt: number, error: E, random: () => number = () => 0): number {
  const decision = Retry.decide(attempt, error, sources({ random }));
  if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
  return decision.delayMs;
}

describe("Retry backoff jitter", () => {
  test("subtracts up to 25% of the ladder delay, scaled by the injected random draw", () => {
    // random=0 → the full delay; random=1 → the 25% floor. Both ends pinned so
    // the multiplier itself is the assertion, not a tolerance band.
    expect(delayOf(1, retryableError(), () => 0)).toBe(Retry.RETRY_INITIAL_DELAY);
    expect(delayOf(1, retryableError(), () => 1)).toBe(Retry.RETRY_INITIAL_DELAY * 0.75);
    expect(delayOf(2, retryableError(), () => 0.5)).toBe(4000 * 0.875);
  });

  test("two consecutive decisions on the same attempt do not collide", () => {
    // The point of jitter: a fleet retrying the same failure spreads out
    // instead of stampeding the endpoint on the same tick.
    const draws = [0.1, 0.9];
    let index = 0;
    const random = () => draws[index++] ?? 0;
    expect(delayOf(3, retryableError(), random)).not.toBe(delayOf(3, retryableError(), random));
  });

  test("never jitters a server-directed wait — retry-after is honored exactly", () => {
    expect(delayOf(1, rateLimitError({ "retry-after": "10" }), () => 1)).toBe(10_000);
    expect(delayOf(1, rateLimitError({ "retry-after-ms": "5000" }), () => 1)).toBe(5000);
  });

  test("stays within the headless cap at every draw", () => {
    expect(delayOf(20, retryableError(), () => 0)).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS);
    expect(delayOf(20, retryableError(), () => 1)).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS * 0.75);
  });
});

describe("Retry billing classification", () => {
  const billingCases: Array<{ name: string; input: SdkErrorInput }> = [
    {
      name: "insufficient_quota code",
      input: {
        message: JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }),
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "quota exceeded prose",
      input: {
        message: JSON.stringify({
          error: { message: "You exceeded your current quota, please check your plan" },
        }),
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "out of budget prose",
      input: { message: "organization is out of budget", isRetryable: true, statusCode: 429 },
    },
    {
      name: "billing prose",
      input: {
        message: JSON.stringify({ error: { type: "billing_error", message: "billing required" } }),
        isRetryable: true,
        statusCode: 400,
      },
    },
    {
      name: "monthly usage limit prose",
      input: {
        message: "monthly usage limit reached for this workspace",
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "quota exhaustion reported in the response body",
      input: {
        message: "Request failed",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
      },
    },
  ];

  test.each(billingCases)("$name is terminal, never retried", ({ input }) => {
    const decision = Retry.decide(1, apiError(input), sources());

    expect(decision.retry).toBe(false);
    if (decision.retry) expect.unreachable("billing exhaustion must not be retryable");
    expect(decision.reason).toBe("billing");
    expect(decision.detail).toBeDefined();
  });

  test("billing outranks the provider's retryable flag and an instant-failure streak", () => {
    const decision = Retry.decide(
      1,
      apiError({ message: "insufficient_quota", isRetryable: true }),
      sources(),
      Retry.INSTANT_FAILURE_STREAK_LIMIT - 1,
    );

    expect(decision).toMatchObject({ retry: false, reason: "billing" });
  });

  test("billing outranks a retry-after header — no wait rescues a spent balance", () => {
    const decision = Retry.decide(
      1,
      apiError({
        message: "insufficient_quota",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "retry-after": "5" },
      }),
      sources(),
    );

    expect(decision).toMatchObject({ retry: false, reason: "billing" });
  });

  test.each([
    {
      message: "billing service temporarily unavailable; retry later",
      statusCode: 503,
      reason: "server_error",
    },
    {
      message: "request exceeded your per minute quota; retry after 1 second",
      statusCode: 429,
      reason: "rate_limit",
    },
    { message: "quota exceeded for this minute", statusCode: 429, reason: "rate_limit" },
  ])("does not confuse transient failures with spent balances: $message", ({
    message,
    statusCode,
    reason,
  }) => {
    const decision = Retry.decide(1, apiError({ message, isRetryable: true, statusCode }), sources());

    expect(decision).toMatchObject({ retry: true, reason });
  });

  test("a transient 429 is NOT billing — rate limits stay retryable", () => {
    const decision = Retry.decide(
      1,
      apiError({
        message: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "request rate limit exceeded" },
        }),
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "retry-after": "5" },
      }),
      sources(),
    );

    expect(decision).toEqual({ retry: true, reason: "rate_limit", delayMs: 5000 });
  });

  test("a bare 429 with no retry-after and no quota headers stays retryable and bounded", () => {
    const decision = Retry.decide(1, rateLimitError(), sources());

    expect(decision).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
    });
    const late = Retry.decide(20, rateLimitError(), sources());
    if (!late.retry) expect.unreachable("a bare 429 must stay retryable");
    expect(late.delayMs).toBeLessThanOrEqual(Retry.RETRY_MAX_DELAY_NO_HEADERS);
  });

  test("keeps `quota_exhausted` on the transient overloaded path", () => {
    // Capacity exhaustion, not balance exhaustion: the provider is telling us
    // to come back, not that the account is spent.
    expect(
      Retry.decide(
        1,
        apiError({ message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true }),
        sources(),
      ).reason,
    ).toBe("overloaded");
  });

  test("billing is terminal vocabulary — never a retryable reason", () => {
    // Compile-time half: billing must not widen the retryable vocabulary the
    // processor's exhaustive RateLimited switch is written against. check-types
    // fails if the @ts-expect-error stops being an error.
    // @ts-expect-error "billing" is deliberately outside RetryableReason.
    const widened: Retry.RetryableReason = "billing" as Retry.Reason;
    void widened;

    // Runtime half: no retryable Decision can carry it.
    const decision = Retry.decide(1, apiError({ message: "billing required", isRetryable: true }), sources());
    expect(decision.retry).toBe(false);
  });
});
