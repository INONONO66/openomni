import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
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

export function classifyRetryReason(errorMessage: string): RetryReason {
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes("timeout") ||
    normalized.includes("aborted") ||
    normalized.includes("budget exceeded")
  ) {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:classify",
      msg: "error classified as timeout",
      context: { error: errorMessage, reason: "timeout" },
    });
    return "timeout";
  }
  if (normalized.includes("tool")) {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:classify",
      msg: "error classified as tool error",
      context: { error: errorMessage, reason: "tool_error" },
    });
    return "tool_error";
  }
  if (normalized.includes("validation")) {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:classify",
      msg: "error classified as validation error",
      context: { error: errorMessage, reason: "validation_error" },
    });
    return "validation_error";
  }
  Bus.publish(Operational.Debug, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "retry:classify",
    msg: "error classified as transient error",
    context: { error: errorMessage, reason: "transient_error" },
  });
  return "transient_error";
}

export function shouldRetry(
  policy: Run.RetryPolicy,
  reason: RetryReason,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:shouldRetry",
      msg: "retry exhausted: max attempts reached",
      context: {
        attempt,
        maxAttempts: policy.maxAttempts,
        reason,
        shouldRetry: false,
      },
    });
    return false;
  }
  if (!policy.retryOn || policy.retryOn.length === 0) {
    const backoffMs = calculateBackoffMs(policy, attempt + 1);
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:shouldRetry",
      msg: "retry decision: will retry (no filter)",
      context: {
        attempt,
        maxAttempts: policy.maxAttempts,
        reason,
        shouldRetry: true,
        backoffMs,
      },
    });
    return true;
  }
  const willRetry = policy.retryOn.includes(reason);
  if (willRetry) {
    const backoffMs = calculateBackoffMs(policy, attempt + 1);
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:shouldRetry",
      msg: "retry decision: will retry (reason allowed)",
      context: {
        attempt,
        maxAttempts: policy.maxAttempts,
        reason,
        shouldRetry: true,
        backoffMs,
      },
    });
  } else {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "retry:shouldRetry",
      msg: "retry decision: will not retry (reason not allowed)",
      context: {
        attempt,
        maxAttempts: policy.maxAttempts,
        reason,
        shouldRetry: false,
      },
    });
  }
  return willRetry;
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
