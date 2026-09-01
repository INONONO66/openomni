import { describe, expect, test, vi } from "bun:test";
import { APIError } from "../../src/error";
import { Retry } from "../../src/retry";

type APIErrorInput = ConstructorParameters<typeof APIError>[0];
const apiError = (input: APIErrorInput) => new APIError(input);

function retryableError(overrides: Partial<APIErrorInput> = {}) {
  return apiError({ message: "boom", isRetryable: true, ...overrides });
}

function rateLimitError(headers?: Record<string, string>) {
  return apiError({
    message: "rate limited",
    isRetryable: true,
    statusCode: 429,
    ...(headers && { responseHeaders: headers }),
  });
}

/** Pins Math.random so a jittered delay is asserted exactly, never by range. */
function withRandom<T>(value: number, fn: () => T): T {
  const random = vi.spyOn(Math, "random").mockReturnValue(value);
  try {
    return fn();
  } finally {
    random.mockRestore();
  }
}

function delayOf(attempt: number, error: unknown): number {
  const decision = Retry.decide(attempt, error);
  if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
  return decision.delayMs;
}

describe("Retry backoff jitter", () => {
  test("subtracts up to 25% of the ladder delay, scaled by the random draw", () => {
    // random=0 → the full delay; random=1 → the 25% floor. Both ends pinned so
    // the multiplier itself is the assertion, not a tolerance band.
    expect(withRandom(0, () => delayOf(1, retryableError()))).toBe(Retry.RETRY_INITIAL_DELAY);
    expect(withRandom(1, () => delayOf(1, retryableError()))).toBe(
      Retry.RETRY_INITIAL_DELAY * 0.75,
    );
    expect(withRandom(0.5, () => delayOf(2, retryableError()))).toBe(4000 * 0.875);
  });

  test("two consecutive decisions on the same attempt do not collide", () => {
    // The point of jitter: a fleet retrying the same failure spreads out
    // instead of stampeding the endpoint on the same tick.
    const draws = [0.1, 0.9];
    let index = 0;
    const random = vi.spyOn(Math, "random").mockImplementation(() => draws[index++] ?? 0);
    try {
      expect(delayOf(3, retryableError())).not.toBe(delayOf(3, retryableError()));
    } finally {
      random.mockRestore();
    }
  });

  test("never jitters a server-directed wait — retry-after is honored exactly", () => {
    expect(withRandom(1, () => delayOf(1, rateLimitError({ "retry-after": "10" })))).toBe(10_000);
    expect(withRandom(1, () => delayOf(1, rateLimitError({ "retry-after-ms": "5000" })))).toBe(
      5000,
    );
  });

  test("stays within the headless cap at every draw", () => {
    expect(withRandom(0, () => delayOf(20, retryableError()))).toBe(
      Retry.RETRY_MAX_DELAY_NO_HEADERS,
    );
    expect(withRandom(1, () => delayOf(20, retryableError()))).toBe(
      Retry.RETRY_MAX_DELAY_NO_HEADERS * 0.75,
    );
  });
});

describe("Retry billing classification", () => {
  const billingCases: Array<{ name: string; input: APIErrorInput }> = [
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
    const decision = Retry.decide(1, apiError(input));

    expect(decision.retry).toBe(false);
    if (decision.retry) expect.unreachable("billing exhaustion must not be retryable");
    expect(decision.reason).toBe("billing");
    expect(decision.detail).toBeDefined();
  });

  test("billing outranks the provider's retryable flag and an instant-failure streak", () => {
    const decision = Retry.decide(
      1,
      apiError({ message: "insufficient_quota", isRetryable: true }),
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
    );

    expect(decision).toMatchObject({ retry: false, reason: "billing" });
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
    );

    expect(decision).toEqual({ retry: true, reason: "rate_limit", delayMs: 5000 });
  });

  test("a bare 429 with no retry-after and no quota headers stays retryable and bounded", () => {
    const decision = withRandom(0, () => Retry.decide(1, rateLimitError()));

    expect(decision).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
    });
    const late = withRandom(0, () => Retry.decide(20, rateLimitError()));
    if (!late.retry) expect.unreachable("a bare 429 must stay retryable");
    expect(late.delayMs).toBeLessThanOrEqual(Retry.RETRY_MAX_DELAY_NO_HEADERS);
  });

  test("keeps `quota_exhausted` on the transient overloaded path", () => {
    // Capacity exhaustion, not balance exhaustion: the provider is telling us
    // to come back, not that the account is spent.
    expect(
      Retry.decide(1, apiError({ message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true }))
        .reason,
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
    const decision = Retry.decide(1, apiError({ message: "billing", isRetryable: true }));
    expect(decision.retry).toBe(false);
  });
});
