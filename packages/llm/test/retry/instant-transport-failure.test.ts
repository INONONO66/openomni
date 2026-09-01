import { describe, expect, test, vi } from "bun:test";
import { APIError } from "../../src/error";
import { Retry } from "../../src/retry";

function transportError(): InstanceType<typeof APIError> {
  // A connection-level failure: retryable, but no HTTP response ever arrived,
  // so there is no status code and there are no response headers.
  return new APIError({ message: "fetch failed", isRetryable: true });
}

function httpError(statusCode: number): InstanceType<typeof APIError> {
  return new APIError({ message: "boom", isRetryable: true, statusCode });
}

describe("Retry.isInstantTransportFailure", () => {
  test("true for a retryable no-status failure under the window", () => {
    expect(Retry.isInstantTransportFailure(transportError(), 100)).toBe(true);
    expect(
      Retry.isInstantTransportFailure(transportError(), Retry.INSTANT_FAILURE_WINDOW_MS - 1),
    ).toBe(true);
  });

  test("false at or above the window — slow failures keep the backoff budget", () => {
    expect(Retry.isInstantTransportFailure(transportError(), Retry.INSTANT_FAILURE_WINDOW_MS)).toBe(
      false,
    );
    expect(Retry.isInstantTransportFailure(transportError(), 30_000)).toBe(false);
  });

  test("false when an HTTP response arrived — the endpoint is up", () => {
    expect(Retry.isInstantTransportFailure(httpError(429), 100)).toBe(false);
    expect(Retry.isInstantTransportFailure(httpError(500), 100)).toBe(false);
  });

  test("false when response headers arrived without a status — the endpoint answered", () => {
    const headerOnly = new APIError({
      message: "rate limited",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "1" },
    });
    expect(Retry.isInstantTransportFailure(headerOnly, 100)).toBe(false);
  });

  test("false for non-APIError values", () => {
    expect(Retry.isInstantTransportFailure(new Error("nope"), 100)).toBe(false);
    expect(Retry.isInstantTransportFailure(undefined, 100)).toBe(false);
  });
});

describe("Retry.decide with an instant-failure streak", () => {
  test("below the limit: retries on the short probe delay, not the backoff ladder", () => {
    const decision = Retry.decide(2, transportError(), 2);
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.delayMs).toBe(Retry.INSTANT_FAILURE_PROBE_DELAY_MS);
      expect(decision.delayMs).toBeLessThan(Retry.RETRY_INITIAL_DELAY);
    }
  });

  test("at the limit: declines with a detail naming the transport streak", () => {
    const decision = Retry.decide(3, transportError(), Retry.INSTANT_FAILURE_STREAK_LIMIT);
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe("server_error");
      expect(decision.detail).toContain("transport");
    }
  });

  test("a zero streak keeps the existing backoff behavior byte-identical", () => {
    // Ladder delays are jittered; a pinned zero draw is the full ladder value,
    // which is the fact this case is about.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const decision = Retry.decide(1, transportError(), 0);
    random.mockRestore();
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.delayMs).toBe(Retry.RETRY_INITIAL_DELAY);
    }
  });

  test("the streak never overrides non_retryable classification", () => {
    const decision = Retry.decide(1, new Error("not api"), Retry.INSTANT_FAILURE_STREAK_LIMIT);
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe("non_retryable");
    }
  });
});
