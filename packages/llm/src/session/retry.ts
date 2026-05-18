import { APIError, RetryError } from "../error";
import { Bus } from "@openomni/session";
import { LlmCall, Operational, type Run } from "@openomni/protocol";

export namespace Retry {
  export const RETRY_INITIAL_DELAY = 2000;
  export const RETRY_BACKOFF_FACTOR = 2;
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000;
  export const RETRY_MAX_DELAY = 2_147_483_647;

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler);
          resolve();
        },
        Math.min(ms, RETRY_MAX_DELAY),
      );
      signal.addEventListener("abort", abortHandler, { once: true });
    });
  }

  export function delay(
    attempt: number,
    error?: InstanceType<typeof APIError>,
    initialDelay?: number,
  ): number {
    const baseDelay = initialDelay ?? RETRY_INITIAL_DELAY;

    if (error) {
      const headers = error.data.responseHeaders;
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"];
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs);
          if (!Number.isNaN(parsedMs)) {
            return parsedMs;
          }
        }

        const retryAfter = headers["retry-after"];
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter);
          if (!Number.isNaN(parsedSeconds)) {
            return Math.ceil(parsedSeconds * 1000);
          }
          const parsed = Date.parse(retryAfter) - Date.now();
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed);
          }
        }

        return baseDelay * RETRY_BACKOFF_FACTOR ** (attempt - 1);
      }
    }

    return Math.min(baseDelay * RETRY_BACKOFF_FACTOR ** (attempt - 1), RETRY_MAX_DELAY_NO_HEADERS);
  }

  export function isRetryable(error: unknown): string | undefined {
    if (!APIError.isInstance(error)) {
      return undefined;
    }

    if (!error.data.isRetryable) {
      return undefined;
    }

    const message = error.data.message;

    try {
      const json = JSON.parse(message);

      if (!json || typeof json !== "object") {
        return undefined;
      }

      const code = typeof json.code === "string" ? json.code : "";

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests";
      }

      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded";
      }

      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited";
      }

      if (
        json.error?.message?.includes("no_kv_space") ||
        (json.type === "error" && json.error?.type === "server_error") ||
        !!json.error
      ) {
        return "Provider Server Error";
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  export interface WithRetryOptions {
    maxAttempts?: number;
    signal?: AbortSignal;
    initialDelay?: number;
    trace?: { traceId: string; sessionId: string; runId?: string; provider?: string };
  }

  export async function withRetry<T>(fn: () => Promise<T>, options?: WithRetryOptions): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 3;
    const signal = options?.signal;
    const initialDelay = options?.initialDelay ?? RETRY_INITIAL_DELAY;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        return await fn();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          throw e;
        }

        lastError = e instanceof Error ? e : new Error(String(e));

        if (attempt === maxAttempts) {
          throw new RetryError({
            message: `Failed after ${maxAttempts} attempts`,
            attempts: maxAttempts,
            lastError: lastError.message,
          });
        }

        if (APIError.isInstance(e)) {
          const retryReason = isRetryable(e);
          if (!retryReason) {
            throw e;
          }

          const delayMs = delay(attempt, e, initialDelay);

          if (options?.trace) {
            const { traceId, sessionId, runId, provider = "unknown" } = options.trace;

            Bus.publish(LlmCall.RetryDecided, {
              traceId,
              sessionId,
              ...(runId !== undefined && { runId }),
              attempt,
              maxAttempts,
              reason: retryReason,
              backoffMs: delayMs,
              time: Date.now(),
            });

            const isRateLimit =
              retryReason === "Too Many Requests" || retryReason === "Rate Limited";
            if (isRateLimit) {
              Bus.publish(LlmCall.RateLimited, {
                traceId,
                sessionId,
                ...(runId !== undefined && { runId }),
                provider,
                retryAfterMs: delayMs,
                time: Date.now(),
              });
            }
          }

          try {
            await sleep(delayMs, signal ?? new AbortController().signal);
          } catch (sleepError) {
            if (sleepError instanceof DOMException && sleepError.name === "AbortError") {
              throw sleepError;
            }
            throw sleepError;
          }
        } else {
          throw lastError;
        }
      }
    }

    throw new RetryError({
      message: `Failed after ${maxAttempts} attempts`,
      attempts: maxAttempts,
      lastError: lastError?.message,
    });
  }

  // Agent-level retry logic (separate from provider-level retries)
  export type AgentRetryReason = "timeout" | "tool_error" | "transient_error" | "validation_error";

  export const DEFAULT_AGENT_RETRY_POLICY: Run.RetryPolicy = {
    maxAttempts: 3,
    backoffMs: { initial: 1000, multiplier: 2, max: 30_000 },
    retryOn: ["timeout", "tool_error", "transient_error"],
  };

  export function calculateAgentBackoffMs(policy: Run.RetryPolicy, attempt: number): number {
    const rawDelay =
      policy.backoffMs.initial * policy.backoffMs.multiplier ** Math.max(0, attempt - 1);
    return Math.min(rawDelay, policy.backoffMs.max);
  }

  export function classifyAgentRetryReason(errorMessage: string): AgentRetryReason {
    const normalized = errorMessage.toLowerCase();
    if (
      normalized.includes("timeout") ||
      normalized.includes("aborted") ||
      normalized.includes("budget exceeded")
    ) {
      Bus.publish(Operational.Debug, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "error classified as timeout",
        context: { error: errorMessage, reason: "timeout" },
      });
      return "timeout";
    }
    if (normalized.includes("tool")) {
      Bus.publish(Operational.Debug, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "error classified as tool error",
        context: { error: errorMessage, reason: "tool_error" },
      });
      return "tool_error";
    }
    if (normalized.includes("validation")) {
      Bus.publish(Operational.Debug, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "error classified as validation error",
        context: { error: errorMessage, reason: "validation_error" },
      });
      return "validation_error";
    }
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "llm.retry",
      msg: "error classified as transient error",
      context: { error: errorMessage, reason: "transient_error" },
    });
    return "transient_error";
  }

  export function shouldAgentRetry(
    policy: Run.RetryPolicy,
    reason: AgentRetryReason,
    attempt: number,
  ): boolean {
    if (attempt >= policy.maxAttempts) {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "retry exhausted: max attempts reached",
        context: { attempt, maxAttempts: policy.maxAttempts, reason, shouldRetry: false },
      });
      return false;
    }
    if (!policy.retryOn || policy.retryOn.length === 0) {
      const backoffMs = calculateAgentBackoffMs(policy, attempt + 1);
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "retry decision: will retry (no filter)",
        context: { attempt, maxAttempts: policy.maxAttempts, reason, shouldRetry: true, backoffMs },
      });
      return true;
    }
    const willRetry = policy.retryOn.includes(reason);
    if (willRetry) {
      const backoffMs = calculateAgentBackoffMs(policy, attempt + 1);
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "retry decision: will retry (reason allowed)",
        context: { attempt, maxAttempts: policy.maxAttempts, reason, shouldRetry: true, backoffMs },
      });
    } else {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "llm.retry",
        msg: "retry decision: will not retry (reason not allowed)",
        context: { attempt, maxAttempts: policy.maxAttempts, reason, shouldRetry: false },
      });
    }
    return willRetry;
  }

  export function agentSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
  }
}
