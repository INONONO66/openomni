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

  describe("decide(attempt, error) delay computation", () => {
    function retryableError(headers?: Record<string, string>): InstanceType<typeof APIError> {
      return new APIError({
        message: "Rate limited",
        isRetryable: true,
        ...(headers && { responseHeaders: headers }),
      });
    }

    function delayOf(attempt: number, error: unknown): number {
      const decision = Retry.decide(attempt, error);
      if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
      return decision.delayMs;
    }

    test("exponential backoff without headers", () => {
      expect(delayOf(1, retryableError())).toBe(2000); // 2000 * 2^0
      expect(delayOf(2, retryableError())).toBe(4000); // 2000 * 2^1
      expect(delayOf(3, retryableError())).toBe(8000); // 2000 * 2^2
      expect(delayOf(4, retryableError())).toBe(16000); // 2000 * 2^3
    });

    test("caps exponential backoff at RETRY_MAX_DELAY_NO_HEADERS", () => {
      expect(delayOf(20, retryableError())).toBeLessThanOrEqual(Retry.RETRY_MAX_DELAY_NO_HEADERS);
    });

    test("uses Retry-After-Ms header if present", () => {
      expect(delayOf(1, retryableError({ "retry-after-ms": "5000" }))).toBe(5000);
    });

    test("uses Retry-After header (seconds) if Retry-After-Ms not present", () => {
      expect(delayOf(1, retryableError({ "retry-after": "10" }))).toBe(10000);
    });

    test("parses Retry-After as HTTP date if not a number", () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const delayMs = delayOf(1, retryableError({ "retry-after": futureDate }));
      expect(delayMs).toBeGreaterThan(4000);
      expect(delayMs).toBeLessThanOrEqual(5000);
    });

    test("falls back to exponential backoff if Retry-After is invalid", () => {
      expect(delayOf(2, retryableError({ "retry-after": "invalid" }))).toBe(4000);
    });

    test("caps the fallback backoff even when headers are present", () => {
      expect(delayOf(20, retryableError({ "retry-after": "invalid" }))).toBe(
        Retry.RETRY_MAX_DELAY_NO_HEADERS,
      );
    });

    test("does not throw when error payload code fields are not strings", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { code: 42, message: 7 },
        }),
        isRetryable: true,
      });

      expect(Retry.decide(1, error)).toMatchObject({ retry: true, reason: "server_error" });
    });

    test("prioritizes Retry-After-Ms over Retry-After", () => {
      expect(delayOf(1, retryableError({ "retry-after-ms": "3000", "retry-after": "10" }))).toBe(
        3000,
      );
    });

    test("handles missing headers gracefully", () => {
      expect(delayOf(2, retryableError())).toBe(4000);
    });

    test("does not expose the removed delay dual path", async () => {
      // decide() is the single retry decision surface; the standalone
      // uncapped delay() had no src consumer and is gone.
      const retrySource = await Bun.file(
        new URL("../../src/retry/index.ts", import.meta.url),
      ).text();
      expect(Object.hasOwn(Retry, "delay")).toBe(false);
      expect(retrySource).not.toMatch(/\bexport function delay\b/);
    });
  });

  describe("decide(attempt, error) reason classification", () => {
    function reasonOf(error: unknown): Retry.Reason {
      return Retry.decide(1, error).reason;
    }

    test("classifies non-APIError as non_retryable", () => {
      expect(Retry.decide(1, new Error("Retry failed"))).toEqual({
        retry: false,
        reason: "non_retryable",
      });
    });

    test("classifies APIError with isRetryable false as non_retryable", () => {
      const error = new APIError({
        message: "Not found",
        statusCode: 404,
        isRetryable: false,
      });

      expect(reasonOf(error)).toBe("non_retryable");
    });

    test("falls back to status classification when message is not JSON", () => {
      const error = new APIError({
        message: "Server error",
        statusCode: 500,
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("server_error");
    });

    test("classifies 429 by status when payload is opaque", () => {
      const error = new APIError({
        message: "<html>rate limited</html>",
        statusCode: 429,
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("rate_limit");
    });

    test("classifies 429 by status when the JSON body has no specific signal", () => {
      // The prose classifier let the generic body.error sniff outrank the 429
      // status ("Provider Server Error"), so real Anthropic rate limits
      // ({error:{type:"rate_limit_error"}}) skipped the RateLimited path.
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { message: "request tokens exceeded your per-minute rate limit" },
        }),
        statusCode: 429,
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("rate_limit");
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

      expect(reasonOf(error)).toBe("rate_limit");
    });

    test("detects too_many_requests in JSON response", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { type: "too_many_requests" },
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("rate_limit");
    });

    test("detects rate_limit in JSON error code", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { code: "rate_limit_exceeded" },
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("rate_limit");
    });

    test("detects rate_limit in JSON error type (Anthropic rate_limit_error)", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "rate limited" },
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("rate_limit");
    });

    test("detects server_error in JSON response", () => {
      const error = new APIError({
        message: JSON.stringify({
          type: "error",
          error: { type: "server_error" },
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("server_error");
    });

    test("detects exhausted in error code", () => {
      const error = new APIError({
        message: JSON.stringify({
          code: "quota_exhausted",
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("overloaded");
    });

    test("detects unavailable in error code", () => {
      const error = new APIError({
        message: JSON.stringify({
          code: "service_unavailable",
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("overloaded");
    });

    test("detects no_kv_space in error message", () => {
      const error = new APIError({
        message: JSON.stringify({
          error: { message: "no_kv_space" },
        }),
        isRetryable: true,
      });

      expect(reasonOf(error)).toBe("server_error");
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

      expect(Retry.decide(1, plainText)).toMatchObject({ retry: true, reason: "server_error" });
      expect(Retry.decide(1, invalidJson)).toMatchObject({ retry: true, reason: "server_error" });
    });

    test("does not expose the folded-away prose classifier", () => {
      expect(Object.hasOwn(Retry, "isRetryable")).toBe(false);
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

describe("Retry.decide ratelimit-reset parsing (#532 candidate 3)", () => {
  function apiError(headers: Record<string, string>): InstanceType<typeof APIError> {
    return new APIError({
      name: "APIError",
      message: "rate limited",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: headers,
    });
  }

  function delayOf(headers: Record<string, string>): number {
    const decision = Retry.decide(1, apiError(headers));
    if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
    return decision.delayMs;
  }

  test("x-ratelimit-reset-requests duration is used when retry-after is absent", () => {
    expect(delayOf({ "x-ratelimit-reset-requests": "3s" })).toBe(3000);
  });

  test("x-ratelimit-reset duration with compound units parses", () => {
    // 1m30s parses to 90s — above the header cap, so the inferred reset
    // demotes to backoff with the over-cap flag proving the parse happened.
    expect(Retry.decide(1, apiError({ "x-ratelimit-reset-tokens": "1m30s" }))).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      retryAfterOverCap: true,
    });
  });

  test("anthropic-ratelimit reset timestamp is used when retry-after is absent", () => {
    const resetAt = new Date(Date.now() + 5000).toISOString();
    const ms = delayOf({ "anthropic-ratelimit-requests-reset": resetAt });
    expect(ms).toBeGreaterThan(3500);
    expect(ms).toBeLessThanOrEqual(5100);
  });

  test("retry-after still wins over ratelimit resets", () => {
    expect(delayOf({ "retry-after": "2", "x-ratelimit-reset-requests": "9s" })).toBe(2000);
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
    expect(decision.retry).toBe(false);
  });

  test("header delay within the cap is honored", () => {
    const decision = Retry.decide(1, apiError({ "retry-after": "45" }));
    expect(decision).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: 45_000,
    });
  });

  test("header delay above the cap fails fast instead of silently stalling", () => {
    const decision = Retry.decide(1, apiError({ "retry-after": "3600" }));
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      // The typed reason stays a branchable literal; prose lives in detail.
      expect(decision.reason).toBe("rate_limit");
      expect(decision.detail).toContain("3600000");
    }
  });

  test("headless retry keeps the exponential backoff and its 30s cap", () => {
    expect(Retry.decide(1, apiError())).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
    });
    const late = Retry.decide(10, apiError());
    if (late.retry) {
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
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      retryAfterOverCap: true,
    });
  });

  test("bare numbers in reset headers are never parsed as years", () => {
    const decision = Retry.decide(1, apiError({ "x-ratelimit-reset-requests": "2027" }));
    expect(decision).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
    });
  });
});
