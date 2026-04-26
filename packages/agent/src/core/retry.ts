import { Log } from "@openomni/session";
import type { Run } from "@openomni/protocol";

export type RetryReason = "timeout" | "tool_error" | "transient_error" | "validation_error";

export const DEFAULT_RETRY_POLICY: Run.RetryPolicy = {
  maxAttempts: 1,
  backoffMs: { initial: 1000, multiplier: 2, max: 30_000 },
  retryOn: ["timeout", "tool_error", "transient_error"],
};

export function calculateBackoffMs(policy: Run.RetryPolicy, attempt: number): number {
  const rawDelay =
    policy.backoffMs.initial * policy.backoffMs.multiplier ** Math.max(0, attempt - 1);
  return Math.min(rawDelay, policy.backoffMs.max);
}

export function classifyRetryReason(errorMessage: string): RetryReason {
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes("timeout") ||
    normalized.includes("aborted") ||
    normalized.includes("budget exceeded")
  ) {
    Log.debug("error classified as timeout", { error: errorMessage, reason: "timeout" });
    return "timeout";
  }
  if (normalized.includes("tool")) {
    Log.debug("error classified as tool error", { error: errorMessage, reason: "tool_error" });
    return "tool_error";
  }
  if (normalized.includes("validation")) {
    Log.debug("error classified as validation error", {
      error: errorMessage,
      reason: "validation_error",
    });
    return "validation_error";
  }
  Log.debug("error classified as transient error", {
    error: errorMessage,
    reason: "transient_error",
  });
  return "transient_error";
}

export function shouldRetry(
  policy: Run.RetryPolicy,
  reason: RetryReason,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) {
    Log.warn("retry exhausted: max attempts reached", {
      attempt,
      maxAttempts: policy.maxAttempts,
      reason,
      shouldRetry: false,
    });
    return false;
  }
  if (!policy.retryOn || policy.retryOn.length === 0) {
    const backoffMs = calculateBackoffMs(policy, attempt + 1);
    Log.warn("retry decision: will retry (no filter)", {
      attempt,
      maxAttempts: policy.maxAttempts,
      reason,
      shouldRetry: true,
      backoffMs,
    });
    return true;
  }
  const willRetry = policy.retryOn.includes(reason);
  if (willRetry) {
    const backoffMs = calculateBackoffMs(policy, attempt + 1);
    Log.warn("retry decision: will retry (reason allowed)", {
      attempt,
      maxAttempts: policy.maxAttempts,
      reason,
      shouldRetry: true,
      backoffMs,
    });
  } else {
    Log.warn("retry decision: will not retry (reason not allowed)", {
      attempt,
      maxAttempts: policy.maxAttempts,
      reason,
      shouldRetry: false,
    });
  }
  return willRetry;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}
