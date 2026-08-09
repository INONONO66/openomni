import { describe, expect, test } from "bun:test";
import { Retry } from "../../src/retry";
import { APIError } from "../../src/error";

describe("Retry", () => {
  test("does not expose removed agent-level retry namespace members", async () => {
    const retrySource = await Bun.file(new URL("../../src/retry/index.ts", import.meta.url)).text();

    expect(Object.hasOwn(Retry, "DEFAULT_AGENT_RETRY_POLICY")).toBe(false);
    expect(Object.hasOwn(Retry, "calculateAgentBackoffMs")).toBe(false);
    expect(Object.hasOwn(Retry, "classifyAgentRetryReason")).toBe(false);
    expect(Object.hasOwn(Retry, "shouldAgentRetry")).toBe(false);
    expect(Object.hasOwn(Retry, "agentSleep")).toBe(false);
    expect(retrySource).not.toMatch(/\bexport\s+type\s+AgentRetryReason\b/);
    expect(retrySource).not.toMatch(/\bexport\s+interface\s+WithRetryOptions\b/);
  });

  describe("sleep(ms, abortSignal)", () => {
    test("resolves after specified milliseconds", async () => {
      const controller = new AbortController();
      const start = Date.now();
      await Retry.sleep(100, controller.signal);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90);
    });

    test("respects AbortSignal and throws AbortError", async () => {
      const controller = new AbortController();
      const promise = Retry.sleep(1000, controller.signal);
      setTimeout(() => controller.abort(), 50);

      try {
        await promise;
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }
    });

    test("clears timeout when aborted", async () => {
      const controller = new AbortController();
      const promise = Retry.sleep(5000, controller.signal);
      controller.abort();

      try {
        await promise;
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect((e as DOMException).name).toBe("AbortError");
      }
    });

    test("rejects immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const start = Date.now();

      try {
        await Retry.sleep(5000, controller.signal);
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }

      expect(Date.now() - start).toBeLessThan(100);
    });

    test("caps delay at RETRY_MAX_DELAY", async () => {
      const controller = new AbortController();
      // Request a delay larger than RETRY_MAX_DELAY
      const promise = Retry.sleep(Retry.RETRY_MAX_DELAY + 1000, controller.signal);

      // Should complete within reasonable time (capped at RETRY_MAX_DELAY)
      setTimeout(() => controller.abort(), 100);

      try {
        await promise;
      } catch {
        // Expected to abort
      }
    });
  });

  describe("delay(attempt, error?)", () => {
    test("exponential backoff without error", () => {
      const delay1 = Retry.delay(1);
      expect(delay1).toBe(2000); // 2000 * 2^0

      const delay2 = Retry.delay(2);
      expect(delay2).toBe(4000); // 2000 * 2^1

      const delay3 = Retry.delay(3);
      expect(delay3).toBe(8000); // 2000 * 2^2

      const delay4 = Retry.delay(4);
      expect(delay4).toBe(16000); // 2000 * 2^3
    });

    test("caps exponential backoff at RETRY_MAX_DELAY_NO_HEADERS", () => {
      // Calculate attempt that would exceed max
      const delay = Retry.delay(20);
      expect(delay).toBeLessThanOrEqual(Retry.RETRY_MAX_DELAY_NO_HEADERS);
    });

    test("uses Retry-After-Ms header if present", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after-ms": "5000",
        },
      });

      const delay = Retry.delay(1, error);
      expect(delay).toBe(5000);
    });

    test("uses Retry-After header (seconds) if Retry-After-Ms not present", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after": "10",
        },
      });

      const delay = Retry.delay(1, error);
      expect(delay).toBe(10000); // 10 seconds converted to ms
    });

    test("parses Retry-After as HTTP date if not a number", () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after": futureDate,
        },
      });

      const delay = Retry.delay(1, error);
      expect(delay).toBeGreaterThan(4000);
      expect(delay).toBeLessThanOrEqual(5000);
    });

    test("falls back to exponential backoff if Retry-After is invalid", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after": "invalid",
        },
      });

      const delay = Retry.delay(2, error);
      expect(delay).toBe(4000); // 2000 * 2^1
    });

    test("caps the fallback backoff even when headers are present", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after": "invalid",
        },
      });

      const delay = Retry.delay(20, error);
      expect(delay).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS);
    });

    test("does not throw when error payload code fields are not strings", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { code: 42, message: 7 },
        }),
        isRetryable: true,
      });

      expect(Retry.isRetryable(error)).toBe("Provider Server Error");
    });

    test("prioritizes Retry-After-Ms over Retry-After", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
        responseHeaders: {
          "retry-after-ms": "3000",
          "retry-after": "10",
        },
      });

      const delay = Retry.delay(1, error);
      expect(delay).toBe(3000);
    });

    test("handles missing headers gracefully", () => {
      const error = new APIError({
        message: "Rate limited",
        isRetryable: true,
      });

      const delay = Retry.delay(2, error);
      expect(delay).toBe(4000); // Falls back to exponential backoff
    });
  });

  describe("isRetryable(error)", () => {
    test("returns undefined if error is not APIError", () => {
      const error = new Error("Retry failed");

      const result = Retry.isRetryable(error);
      expect(result).toBeUndefined();
    });

    test("returns undefined if APIError.isRetryable is false", () => {
      const error = new APIError({
        message: "Not found",
        statusCode: 404,
        isRetryable: false,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBeUndefined();
    });

    test("falls back to status classification when message is not JSON", () => {
      const error = new APIError({
        message: "Server error",
        statusCode: 500,
        isRetryable: true,
      });

      expect(Retry.isRetryable(error)).toBe("Provider Server Error");
    });

    test("classifies 429 by status when payload is opaque", () => {
      const error = new APIError({
        message: "<html>rate limited</html>",
        statusCode: 429,
        isRetryable: true,
      });

      expect(Retry.isRetryable(error)).toBe("Rate Limited");
    });

    test("classifies from responseBody when message is opaque", () => {
      const error = new APIError({
        message: "Overloaded",
        isRetryable: true,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "too_many_requests" },
        }),
      });

      expect(Retry.isRetryable(error)).toBe("Too Many Requests");
    });

    test("detects too_many_requests in JSON response", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { type: "too_many_requests" },
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Too Many Requests");
    });

    test("detects rate_limit in JSON response", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { code: "rate_limit_exceeded" },
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Rate Limited");
    });

    test("detects server_error in JSON response", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { type: "server_error" },
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Provider Server Error");
    });

    test("detects exhausted in error code", () => {
      const error = new APIError({
        message: JSON.stringify({
          code: "quota_exhausted",
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Provider is overloaded");
    });

    test("detects unavailable in error code", () => {
      const error = new APIError({
        message: JSON.stringify({
          code: "service_unavailable",
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Provider is overloaded");
    });

    test("detects no_kv_space in error message", () => {
      const error = new APIError({
        message: JSON.stringify({
          error: { message: "no_kv_space" },
        }),
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBe("Provider Server Error");
    });

    test("trusts the provider retryable flag when payload and status are opaque", () => {
      // The SDK only sets isRetryable for transient failures (408/409/429/5xx,
      // x-should-retry); an unparseable payload must not veto that signal.
      const plainText = new APIError({
        message: "Plain text error",
        isRetryable: true,
      });
      const invalidJson = new APIError({
        message: "{ invalid json",
        isRetryable: true,
      });

      expect(Retry.isRetryable(plainText)).toBe("Provider Error");
      expect(Retry.isRetryable(invalidJson)).toBe("Provider Error");
    });
  });

  describe("removed retry wrapper", () => {
    test("does not expose withRetry", async () => {
      const retrySource = await Bun.file(
        new URL("../../src/retry/index.ts", import.meta.url),
      ).text();

      expect(Object.hasOwn(Retry, "withRetry")).toBe(false);
      expect(retrySource).not.toMatch(/\bwithRetry\b/);
    });
  });
});

describe("Retry.delay ratelimit-reset parsing (#532 candidate 3)", () => {
  function apiError(headers: Record<string, string>): InstanceType<typeof APIError> {
    return new APIError({
      name: "APIError",
      message: "rate limited",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: headers,
    });
  }

  test("x-ratelimit-reset-requests duration is used when retry-after is absent", () => {
    expect(Retry.delay(1, apiError({ "x-ratelimit-reset-requests": "3s" }))).toBe(3000);
  });

  test("x-ratelimit-reset duration with compound units parses", () => {
    expect(Retry.delay(1, apiError({ "x-ratelimit-reset-tokens": "1m30s" }))).toBe(90_000);
  });

  test("anthropic-ratelimit reset timestamp is used when retry-after is absent", () => {
    const resetAt = new Date(Date.now() + 5000).toISOString();
    const ms = Retry.delay(1, apiError({ "anthropic-ratelimit-requests-reset": resetAt }));
    expect(ms).toBeGreaterThan(3500);
    expect(ms).toBeLessThanOrEqual(5100);
  });

  test("retry-after still wins over ratelimit resets", () => {
    expect(
      Retry.delay(1, apiError({ "retry-after": "2", "x-ratelimit-reset-requests": "9s" })),
    ).toBe(2000);
  });
});

describe("Retry.decide (#532 candidate 3)", () => {
  function apiError(headers?: Record<string, string>): InstanceType<typeof APIError> {
    return new APIError({
      name: "APIError",
      message: "rate limited",
      isRetryable: true,
      statusCode: 429,
      ...(headers && { responseHeaders: headers }),
    });
  }

  test("non-retryable errors decide against retry", () => {
    const decision = Retry.decide(1, new Error("plain"));
    expect(decision.retryable).toBe(false);
  });

  test("header delay within the cap is honored", () => {
    const decision = Retry.decide(1, apiError({ "retry-after": "45" }));
    expect(decision).toEqual({
      retryable: true,
      reason: "Rate Limited",
      delayMs: 45_000,
      source: "header",
    });
  });

  test("header delay above the cap fails fast instead of silently stalling", () => {
    const decision = Retry.decide(1, apiError({ "retry-after": "3600" }));
    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toContain("3600000");
    }
  });

  test("headless retry keeps the exponential backoff and its 30s cap", () => {
    expect(Retry.decide(1, apiError())).toEqual({
      retryable: true,
      reason: "Rate Limited",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      source: "backoff",
    });
    const late = Retry.decide(10, apiError());
    if (late.retryable) {
      expect(late.delayMs).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS);
    }
  });
});

describe("Retry.decide cap semantics for inferred resets", () => {
  function apiError(headers: Record<string, string>): InstanceType<typeof APIError> {
    return new APIError({
      name: "APIError",
      message: "rate limited",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: headers,
    });
  }

  test("an out-of-range ratelimit reset demotes to backoff instead of failing", () => {
    const decision = Retry.decide(1, apiError({ "x-ratelimit-reset-requests": "30m" }));
    expect(decision).toEqual({
      retryable: true,
      reason: "Rate Limited",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      source: "backoff",
    });
  });

  test("bare numbers in reset headers are never parsed as years", () => {
    const decision = Retry.decide(1, apiError({ "x-ratelimit-reset-requests": "2027" }));
    expect(decision).toEqual({
      retryable: true,
      reason: "Rate Limited",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      source: "backoff",
    });
  });
});
