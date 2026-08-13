import type { Run } from "@openomni/protocol";

export type RetryReason = "timeout" | "tool_error" | "transient_error" | "validation_error";

export const DEFAULT_RETRY_POLICY: Run.RetryPolicy = {
  maxAttempts: 3,
  backoffMs: { initial: 1000, multiplier: 2, max: 30_000 },
  retryOn: ["timeout", "tool_error", "transient_error"],
};

export function calculateBackoffMs(policy: Run.RetryPolicy, attempt: number): number {
  const rawDelay =
    policy.backoffMs.initial * policy.backoffMs.multiplier ** Math.max(0, attempt - 1);
  return Math.min(rawDelay, policy.backoffMs.max);
}

/**
 * Classifies an error for the retry policy. Pure: it reads a string and
 * returns a reason.
 *
 * It used to narrate every branch through the Bus under a freshly minted
 * trace — eight events describing a decision the caller already reports, on
 * the run's own trace, two statements later (`emitErrorRetry` /
 * `emitRunFailed`). A record that duplicates a correlated one under an
 * uncorrelated id is worse than no record.
 */
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

/**
 * Whether this attempt may be retried. An empty or absent `retryOn` means no
 * filter, so every reason is retryable up to `maxAttempts`.
 */
export function shouldRetry(
  policy: Run.RetryPolicy,
  reason: RetryReason,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (policy.retryOn === undefined || policy.retryOn.length === 0) return true;
  return policy.retryOn.includes(reason);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("aborted"));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, Math.floor(ms)),
    );

    function onAbort(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
