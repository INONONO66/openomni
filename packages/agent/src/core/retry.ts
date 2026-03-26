import type { Run } from "@openomni/protocol";

export type RetryReason = "timeout" | "tool_error" | "transient_error" | "validation_error";

export const DEFAULT_RETRY_POLICY: Run.RetryPolicy = {
  maxAttempts: 1,
  backoffMs: { initial: 1000, multiplier: 2, max: 30_000 },
  retryOn: ["timeout", "tool_error", "transient_error"],
};

export function calculateBackoffMs(policy: Run.RetryPolicy, attempt: number): number {
  const rawDelay =
    policy.backoffMs.initial * Math.pow(policy.backoffMs.multiplier, Math.max(0, attempt - 1));
  return Math.min(rawDelay, policy.backoffMs.max);
}

export function classifyRetryReason(errorMessage: string): RetryReason {
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes("timeout") ||
    normalized.includes("aborted") ||
    normalized.includes("budget exceeded")
  ) {
    return "timeout";
  }
  if (normalized.includes("tool")) {
    return "tool_error";
  }
  if (normalized.includes("validation")) {
    return "validation_error";
  }
  return "transient_error";
}

export function shouldRetry(
  policy: Run.RetryPolicy,
  reason: RetryReason,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) {
    return false;
  }
  if (!policy.retryOn || policy.retryOn.length === 0) {
    return true;
  }
  return policy.retryOn.includes(reason);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}
