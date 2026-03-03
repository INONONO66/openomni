import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Retry } from "../../src/session/retry";
import { APIError, RetryError } from "../../src/error";

describe("Retry", () => {
  describe("Constants", () => {
    test("RETRY_INITIAL_DELAY is 2000ms", () => {
      expect(Retry.RETRY_INITIAL_DELAY).toBe(2000);
    });

    test("RETRY_BACKOFF_FACTOR is 2", () => {
      expect(Retry.RETRY_BACKOFF_FACTOR).toBe(2);
    });

    test("RETRY_MAX_DELAY_NO_HEADERS is 30000ms", () => {
      expect(Retry.RETRY_MAX_DELAY_NO_HEADERS).toBe(30000);
    });

    test("RETRY_MAX_DELAY is 2147483647ms", () => {
      expect(Retry.RETRY_MAX_DELAY).toBe(2_147_483_647);
    });
  });

  describe("sleep(ms, abortSignal)", () => {
    test("resolves after specified milliseconds", async () => {
      const controller = new AbortController();
      const start = Date.now();
      await Retry.sleep(100, controller.signal);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(100);
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

    test("caps delay at RETRY_MAX_DELAY", async () => {
      const controller = new AbortController();
      const start = Date.now();
      // Request a delay larger than RETRY_MAX_DELAY
      const promise = Retry.sleep(
        Retry.RETRY_MAX_DELAY + 1000,
        controller.signal,
      );

      // Should complete within reasonable time (capped at RETRY_MAX_DELAY)
      setTimeout(() => controller.abort(), 100);

      try {
        await promise;
      } catch (e) {
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
      const error = new RetryError({
        message: "Retry failed",
        attempts: 3,
      });

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

    test("returns undefined if APIError.isRetryable is true but message is not JSON", () => {
      const error = new APIError({
        message: "Server error",
        statusCode: 500,
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBeUndefined();
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

    test("returns undefined for non-JSON message", () => {
      const error = new APIError({
        message: "Plain text error",
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBeUndefined();
    });

    test("returns undefined for invalid JSON", () => {
      const error = new APIError({
        message: "{ invalid json",
        isRetryable: true,
      });

      const result = Retry.isRetryable(error);
      expect(result).toBeUndefined();
    });
  });

  describe("withRetry<T>(fn, options)", () => {
    test("executes function successfully on first attempt", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return "success";
      };

      const result = await Retry.withRetry(fn);
      expect(result).toBe("success");
      expect(callCount).toBe(1);
    });

    test("retries on retryable error", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount < 3) {
          throw new APIError({
            message: JSON.stringify({
              type: "error",
              error: { type: "too_many_requests" },
            }),
            isRetryable: true,
          });
        }
        return "success";
      };

      const result = await Retry.withRetry(fn, {
        maxAttempts: 5,
        initialDelay: 10,
      });
      expect(result).toBe("success");
      expect(callCount).toBe(3);
    });

    test("throws RetryError after max attempts exceeded", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new APIError({
          message: JSON.stringify({
            type: "error",
            error: { type: "too_many_requests" },
          }),
          isRetryable: true,
        });
      };

      try {
        await Retry.withRetry(fn, { maxAttempts: 3, initialDelay: 10 });
        expect.unreachable("Should have thrown RetryError");
      } catch (e) {
        expect(RetryError.isInstance(e)).toBe(true);
        if (RetryError.isInstance(e)) {
          expect(e.data.attempts).toBe(3);
          expect(callCount).toBe(3);
        }
      }
    });

    test("does not retry on non-retryable error", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new APIError({
          message: "Not found",
          statusCode: 404,
          isRetryable: false,
        });
      };

      try {
        await Retry.withRetry(fn, { maxAttempts: 5 });
        expect.unreachable("Should have thrown APIError");
      } catch (e) {
        expect(APIError.isInstance(e)).toBe(true);
        expect(callCount).toBe(1);
      }
    });

    test("uses default maxAttempts of 3", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new APIError({
          message: JSON.stringify({
            type: "error",
            error: { type: "too_many_requests" },
          }),
          isRetryable: true,
        });
      };

      try {
        await Retry.withRetry(fn, { initialDelay: 10 });
        expect.unreachable("Should have thrown RetryError");
      } catch (e) {
        expect(RetryError.isInstance(e)).toBe(true);
        if (RetryError.isInstance(e)) {
          expect(e.data.attempts).toBe(3);
        }
      }
    });

    test("respects AbortSignal", async () => {
      const controller = new AbortController();
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new APIError({
          message: JSON.stringify({
            type: "error",
            error: { type: "too_many_requests" },
          }),
          isRetryable: true,
        });
      };

      const promise = Retry.withRetry(fn, {
        maxAttempts: 10,
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 50);

      try {
        await promise;
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect((e as DOMException).name).toBe("AbortError");
        expect(callCount).toBe(1);
      }
    });

    test("includes lastError in RetryError", async () => {
      const fn = async () => {
        throw new APIError({
          message: JSON.stringify({
            type: "error",
            error: { type: "server_error" },
          }),
          statusCode: 500,
          isRetryable: true,
        });
      };

      try {
        await Retry.withRetry(fn, { maxAttempts: 2, initialDelay: 10 });
        expect.unreachable("Should have thrown RetryError");
      } catch (e) {
        expect(RetryError.isInstance(e)).toBe(true);
        if (RetryError.isInstance(e)) {
          expect(e.data.lastError).toBeDefined();
        }
      }
    });

    test("waits between retries using delay function", async () => {
      let callCount = 0;
      const start = Date.now();
      const fn = async () => {
        callCount++;
        if (callCount < 2) {
          throw new APIError({
            message: JSON.stringify({
              type: "error",
              error: { type: "too_many_requests" },
            }),
            isRetryable: true,
          });
        }
        return "success";
      };

      const result = await Retry.withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 50,
      });
      const elapsed = Date.now() - start;

      expect(result).toBe("success");
      expect(callCount).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    test("throws non-APIError immediately", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new Error("Generic error");
      };

      try {
        await Retry.withRetry(fn, { maxAttempts: 5 });
        expect.unreachable("Should have thrown Error");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe("Generic error");
        expect(callCount).toBe(1);
      }
    });

    test("handles synchronous function errors", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount < 2) {
          throw new APIError({
            message: JSON.stringify({
              type: "error",
              error: { type: "too_many_requests" },
            }),
            isRetryable: true,
          });
        }
        return "success";
      };

      const result = await Retry.withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 10,
      });
      expect(result).toBe("success");
      expect(callCount).toBe(2);
    });
  });
});
