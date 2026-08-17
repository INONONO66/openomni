import { describe, expect, it } from "bun:test";
import type { Run } from "@openomni/protocol";
import {
  abortError,
  calculateBackoffMs,
  classifyRetryReason,
  isAbort,
  shouldRetry,
  sleep,
} from "../../src/core/retry";

describe("Retry.sleep", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();

    await expect(sleep(5_000, controller.signal)).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("rejects when the signal aborts during sleep", async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 5);
    const started = Date.now();

    await expect(sleep(5_000, controller.signal)).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("removes the abort listener after normal completion", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    const originalRemoveEventListener = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;

    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      added += 1;
      return originalAddEventListener(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed += 1;
      return originalRemoveEventListener(...args);
    }) as AbortSignal["removeEventListener"];

    await sleep(1, signal);

    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});

/**
 * These were unreachable from any test until #613 made them pure: they
 * reported their own decisions to the Bus, so "it emitted something" stood in
 * for "it decided correctly". Now the decision is only visible through the
 * return value, which is the thing worth pinning anyway.
 */
describe("classifyRetryReason", () => {
  it.each([
    ["connection timeout", "timeout"],
    // Audit M4 (pinned-wrong-behavior rows changed with the fix): "aborted"
    // and "budget exceeded" substrings used to classify as the retryable
    // "timeout". Aborts are decided by identity via `isAbort`, never by
    // message; budget exhaustion never throws. Both fall through here.
    ["run aborted by guard", "transient_error"],
    ["budget exceeded: turns", "transient_error"],
    ["tool execution failed", "tool_error"],
    ["schema validation failed", "validation_error"],
    // "tool" is checked before "validation", so a message carrying both is a
    // tool error. Rows that mention only one cannot pin that order.
    ["tool input validation failed", "tool_error"],
    ["upstream 503", "transient_error"],
    ["TIMEOUT IN CAPS", "timeout"],
  ] as const)("classifies %j as %s", (message, expected) => {
    expect(classifyRetryReason(message)).toBe(expected);
  });
});

describe("isAbort (audit M4)", () => {
  it("recognizes an aborted signal regardless of the error message", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("connection timeout"), controller.signal)).toBe(true);
  });

  it("recognizes the typed abort error without a signal", () => {
    expect(isAbort(abortError(), undefined)).toBe(true);
    expect(abortError().name).toBe("AbortError");
  });

  it("does NOT classify by message substring: a tool error mentioning 'aborted' is not an abort", () => {
    const controller = new AbortController();
    expect(isAbort(new Error("tool run aborted by remote host"), controller.signal)).toBe(false);
  });
});

describe("shouldRetry", () => {
  const policy: Run.RetryPolicy = {
    maxAttempts: 3,
    backoffMs: { initial: 10, multiplier: 2, max: 100 },
    retryOn: ["timeout"],
  };

  it("stops at the attempt ceiling", () => {
    expect(shouldRetry({ ...policy }, "timeout", 3)).toBe(false);
    expect(shouldRetry({ ...policy }, "timeout", 2)).toBe(true);
  });

  it("refuses a reason the filter excludes", () => {
    expect(shouldRetry({ ...policy }, "tool_error", 1)).toBe(false);
  });

  it("treats an absent or empty filter as no filter", () => {
    const noFilter = { maxAttempts: 3, backoffMs: policy.backoffMs };
    expect(shouldRetry(noFilter, "validation_error", 1)).toBe(true);
    expect(shouldRetry({ ...noFilter, retryOn: [] }, "validation_error", 1)).toBe(true);
  });
});

describe("calculateBackoffMs", () => {
  const policy = { maxAttempts: 5, backoffMs: { initial: 100, multiplier: 2, max: 500 } };

  it("grows geometrically from the first attempt", () => {
    expect(calculateBackoffMs(policy, 1)).toBe(100);
    expect(calculateBackoffMs(policy, 2)).toBe(200);
    expect(calculateBackoffMs(policy, 3)).toBe(400);
  });

  it("clamps at max", () => {
    expect(calculateBackoffMs(policy, 4)).toBe(500);
    expect(calculateBackoffMs(policy, 40)).toBe(500);
  });

  it("does not go below the initial delay", () => {
    expect(calculateBackoffMs(policy, 0)).toBe(100);
  });
});
