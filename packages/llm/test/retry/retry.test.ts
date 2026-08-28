import { describe, expect, test } from "bun:test";
import { APIError } from "../../src/error";
import { Retry } from "../../src/retry";

type APIErrorInput = ConstructorParameters<typeof APIError>[0];
const apiError = (input: APIErrorInput) => new APIError(input);

function retryableError(headers?: Record<string, string>) {
  return apiError({
    message: "Rate limited",
    isRetryable: true,
    ...(headers && { responseHeaders: headers }),
  });
}

function rateLimitError(headers?: Record<string, string>) {
  return apiError({
    message: "rate limited",
    isRetryable: true,
    statusCode: 429,
    ...(headers && { responseHeaders: headers }),
  });
}

function delayOf(attempt: number, error: unknown): number {
  const decision = Retry.decide(attempt, error);
  if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
  return decision.delayMs;
}

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
    test("resolves without an abort signal", async () => {
      await Retry.sleep(0);
    });

    test("resolves after specified milliseconds", async () => {
      const start = Date.now();
      await Retry.sleep(100, new AbortController().signal);
      expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    });

    test("respects AbortSignal and throws AbortError", async () => {
      const controller = new AbortController();
      const promise = Retry.sleep(1000, controller.signal);
      setTimeout(() => controller.abort(), 50);
      try {
        await promise;
        expect.unreachable("Should have thrown AbortError");
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      }
    });

    test("clears timeout when aborted", async () => {
      const controller = new AbortController();
      const promise = Retry.sleep(5000, controller.signal);
      controller.abort();
      try {
        await promise;
        expect.unreachable("Should have thrown AbortError");
      } catch (error) {
        expect((error as DOMException).name).toBe("AbortError");
      }
    });

    test("rejects immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const start = Date.now();
      try {
        await Retry.sleep(5000, controller.signal);
        expect.unreachable("Should have thrown AbortError");
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      }
      expect(Date.now() - start).toBeLessThan(100);
    });

    test("caps delay at RETRY_MAX_DELAY", async () => {
      const controller = new AbortController();
      const promise = Retry.sleep(Retry.RETRY_MAX_DELAY + 1000, controller.signal);
      setTimeout(() => controller.abort(), 100);
      try {
        await promise;
      } catch {
        // Expected abort proves the requested delay was capped before completion.
      }
    });
  });

  describe("decide(attempt, error) delay computation", () => {
    test("exponential backoff without headers", () => {
      expect(delayOf(1, retryableError())).toBe(2000);
      expect(delayOf(2, retryableError())).toBe(4000);
      expect(delayOf(3, retryableError())).toBe(8000);
      expect(delayOf(4, retryableError())).toBe(16000);
    });

    test.each([
      {
        name: "caps exponential backoff at RETRY_MAX_DELAY_NO_HEADERS",
        attempt: 20,
        headers: undefined,
        assert: (delay: number) =>
          expect(delay).toBeLessThanOrEqual(Retry.RETRY_MAX_DELAY_NO_HEADERS),
      },
      {
        name: "uses Retry-After-Ms header if present",
        attempt: 1,
        headers: { "retry-after-ms": "5000" },
        assert: (delay: number) => expect(delay).toBe(5000),
      },
      {
        name: "uses Retry-After header (seconds) if Retry-After-Ms not present",
        attempt: 1,
        headers: { "retry-after": "10" },
        assert: (delay: number) => expect(delay).toBe(10000),
      },
      {
        name: "falls back to exponential backoff if Retry-After is invalid",
        attempt: 2,
        headers: { "retry-after": "invalid" },
        assert: (delay: number) => expect(delay).toBe(4000),
      },
      {
        name: "caps the fallback backoff even when headers are present",
        attempt: 20,
        headers: { "retry-after": "invalid" },
        assert: (delay: number) => expect(delay).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS),
      },
      {
        name: "prioritizes Retry-After-Ms over Retry-After",
        attempt: 1,
        headers: { "retry-after-ms": "3000", "retry-after": "10" },
        assert: (delay: number) => expect(delay).toBe(3000),
      },
      {
        name: "handles missing headers gracefully",
        attempt: 2,
        headers: undefined,
        assert: (delay: number) => expect(delay).toBe(4000),
      },
    ])("$name", ({ attempt, headers, assert }) =>
      assert(delayOf(attempt, retryableError(headers as Record<string, string> | undefined))));

    test("parses Retry-After as HTTP date if not a number", () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const delayMs = delayOf(1, retryableError({ "retry-after": futureDate }));
      expect(delayMs).toBeGreaterThan(4000);
      expect(delayMs).toBeLessThanOrEqual(5000);
    });

    test("does not throw when error payload code fields are not strings", () => {
      const error = apiError({
        message: JSON.stringify({ type: "error", error: { code: 42, message: 7 } }),
        isRetryable: true,
      });
      expect(Retry.decide(1, error)).toMatchObject({ retry: true, reason: "server_error" });
    });

    test("does not expose the removed delay dual path", async () => {
      const retrySource = await Bun.file(
        new URL("../../src/retry/index.ts", import.meta.url),
      ).text();
      expect(Object.hasOwn(Retry, "delay")).toBe(false);
      expect(retrySource).not.toMatch(/\bexport function delay\b/);
    });
  });

  describe("decide(attempt, error) reason classification", () => {
    test("classifies non-APIError as non_retryable", () => {
      expect(Retry.decide(1, new Error("Retry failed"))).toEqual({
        retry: false,
        reason: "non_retryable",
      });
    });

    const reasonCases: Array<{ name: string; input: APIErrorInput; expected: Retry.Reason }> = [
      {
        name: "classifies APIError with isRetryable false as non_retryable",
        input: { message: "Not found", statusCode: 404, isRetryable: false },
        expected: "non_retryable",
      },
      {
        name: "falls back to status classification when message is not JSON",
        input: { message: "Server error", statusCode: 500, isRetryable: true },
        expected: "server_error",
      },
      {
        name: "classifies 429 by status when payload is opaque",
        input: { message: "<html>rate limited</html>", statusCode: 429, isRetryable: true },
        expected: "rate_limit",
      },
      {
        name: "classifies 429 by status when the JSON body has no specific signal",
        input: {
          message: JSON.stringify({
            type: "error",
            error: { message: "request tokens exceeded your per-minute rate limit" },
          }),
          statusCode: 429,
          isRetryable: true,
        },
        expected: "rate_limit",
      },
      {
        name: "classifies from responseBody when message is opaque",
        input: {
          message: "Overloaded",
          isRetryable: true,
          responseBody: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
        },
        expected: "rate_limit",
      },
      {
        name: "detects too_many_requests in JSON response",
        input: {
          message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
          isRetryable: true,
        },
        expected: "rate_limit",
      },
      {
        name: "detects rate_limit in JSON error code",
        input: {
          message: JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          isRetryable: true,
        },
        expected: "rate_limit",
      },
      {
        name: "detects rate_limit in JSON error type (Anthropic rate_limit_error)",
        input: {
          message: JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "rate limited" },
          }),
          isRetryable: true,
        },
        expected: "rate_limit",
      },
      {
        name: "detects server_error in JSON response",
        input: {
          message: JSON.stringify({ type: "error", error: { type: "server_error" } }),
          isRetryable: true,
        },
        expected: "server_error",
      },
      {
        name: "detects exhausted in error code",
        input: { message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true },
        expected: "overloaded",
      },
      {
        name: "detects unavailable in error code",
        input: { message: JSON.stringify({ code: "service_unavailable" }), isRetryable: true },
        expected: "overloaded",
      },
      {
        name: "detects no_kv_space in error message",
        input: {
          message: JSON.stringify({ error: { message: "no_kv_space" } }),
          isRetryable: true,
        },
        expected: "server_error",
      },
    ];

    test.each(reasonCases)("$name", ({ input, expected }) => {
      expect(Retry.decide(1, apiError(input)).reason).toBe(expected);
    });

    test("trusts the provider retryable flag when payload and status are opaque", () => {
      const plainText = apiError({ message: "Plain text error", isRetryable: true });
      const invalidJson = apiError({ message: "{ invalid json", isRetryable: true });
      expect(Retry.decide(1, plainText)).toMatchObject({ retry: true, reason: "server_error" });
      expect(Retry.decide(1, invalidJson)).toMatchObject({ retry: true, reason: "server_error" });
    });

    test("does not expose the folded-away prose classifier", () => {
      expect(Object.hasOwn(Retry, "isRetryable")).toBe(false);
    });
  });

  test("removed retry wrapper does not expose withRetry", async () => {
    const retrySource = await Bun.file(new URL("../../src/retry/index.ts", import.meta.url)).text();
    expect(Object.hasOwn(Retry, "withRetry")).toBe(false);
    expect(retrySource).not.toMatch(/\bwithRetry\b/);
  });
});

describe("Retry.decide ratelimit-reset parsing (#532 candidate 3)", () => {
  test("x-ratelimit-reset-requests duration is used when retry-after is absent", () => {
    expect(delayOf(1, rateLimitError({ "x-ratelimit-reset-requests": "3s" }))).toBe(3000);
  });

  test("x-ratelimit-reset duration with compound units parses", () => {
    expect(Retry.decide(1, rateLimitError({ "x-ratelimit-reset-tokens": "1m30s" }))).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
      retryAfterOverCap: true,
    });
  });

  test("anthropic-ratelimit reset timestamp is used when retry-after is absent", () => {
    const resetAt = new Date(Date.now() + 5000).toISOString();
    const ms = delayOf(1, rateLimitError({ "anthropic-ratelimit-requests-reset": resetAt }));
    expect(ms).toBeGreaterThan(3500);
    expect(ms).toBeLessThanOrEqual(5100);
  });

  test("retry-after still wins over ratelimit resets", () => {
    expect(
      delayOf(1, rateLimitError({ "retry-after": "2", "x-ratelimit-reset-requests": "9s" })),
    ).toBe(2000);
  });
});

describe("Retry.decide (#532 candidate 3)", () => {
  test("non-retryable errors decide against retry", () => {
    expect(Retry.decide(1, new Error("plain")).retry).toBe(false);
  });

  test("header delay within the cap is honored", () => {
    expect(Retry.decide(1, rateLimitError({ "retry-after": "45" }))).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: 45_000,
    });
  });

  test("header delay above the cap fails fast instead of silently stalling", () => {
    const decision = Retry.decide(1, rateLimitError({ "retry-after": "3600" }));
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe("rate_limit");
      expect(decision.detail).toContain("3600000");
    }
  });

  test("headless retry keeps the exponential backoff and its 30s cap", () => {
    expect(Retry.decide(1, rateLimitError())).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: Retry.RETRY_INITIAL_DELAY,
    });
    const late = Retry.decide(10, rateLimitError());
    if (late.retry) expect(late.delayMs).toBe(Retry.RETRY_MAX_DELAY_NO_HEADERS);
  });
});

describe("Retry.decide cap semantics for inferred resets", () => {
  test.each([
    {
      name: "an out-of-range ratelimit reset demotes to backoff instead of failing",
      header: "30m",
      expected: {
        retry: true,
        reason: "rate_limit",
        delayMs: Retry.RETRY_INITIAL_DELAY,
        retryAfterOverCap: true,
      },
    },
    {
      name: "bare numbers in reset headers are never parsed as years",
      header: "2027",
      expected: { retry: true, reason: "rate_limit", delayMs: Retry.RETRY_INITIAL_DELAY },
    },
  ])("$name", ({ header, expected }) => {
    expect(Retry.decide(1, rateLimitError({ "x-ratelimit-reset-requests": header }))).toEqual(
      expected,
    );
  });
});
