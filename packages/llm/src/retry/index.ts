import { z } from "zod";
import { APIError, coerceApiError } from "../error";
import { headerDelay } from "./delay";

const Payload = z.object({
  type: z.string().catch(""),
  code: z.string().catch(""),
  error: z
    .object({
      type: z.string().catch(""),
      code: z.string().catch(""),
      message: z.string().catch(""),
    })
    .catch({ type: "", code: "", message: "" }),
});

export namespace Retry {
  export const MAX_ATTEMPTS = 3;

  export function isContextOverflow(error: Error): boolean {
    if (
      "data" in error &&
      typeof error.data === "object" &&
      error.data !== null &&
      "contextOverflow" in error.data
    )
      return error.data.contextOverflow === true;
    const message = error.message.toLowerCase();
    return [
      "context_length_exceeded",
      "context length",
      "context limit",
      "context window",
      "maximum context",
      "prompt is too long",
      "too many tokens",
      "token limit",
      "exceeds the maximum number of tokens",
      "input is too long",
    ].some((pattern) => message.includes(pattern));
  }

  /** Existing placement/agent machine vocabulary, derived beside provider classification. */
  export function attemptReason(
    error: Error,
  ): "timeout" | "transient_error" | "validation_error" | "context_overflow" {
    if (isContextOverflow(error)) return "context_overflow";
    const api = apiCause(error);
    if (api?.data.statusCode === 408) return "timeout";
    return api !== undefined && !api.data.isRetryable ? "validation_error" : "transient_error";
  }
  export const RETRY_INITIAL_DELAY = 2000;
  export const RETRY_BACKOFF_FACTOR = 2;
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000;
  export const RETRY_MAX_DELAY = 2_147_483_647;

  export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timeout = setTimeout(
        () => {
          signal?.removeEventListener("abort", abortHandler);
          resolve();
        },
        Math.min(ms, RETRY_MAX_DELAY),
      );
      signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  /**
   * Server-directed waits above this cap fail fast instead of silently
   * stalling a run mid-flight: the headless backoff already tops out at 30s,
   * so a server asking for more than twice that budget surfaces as a visible
   * failure whose retry policy belongs to the caller.
   */
  export const RETRY_HEADER_DELAY_CAP = 60_000;

  /**
   * Backoff exists to relieve an overloaded endpoint; it cannot help one
   * refusing connections outright. A retryable failure that carries no HTTP
   * status and dies under this window is the signature of the latter, so a
   * streak of them retries on the short probe delay and then declines,
   * instead of burning the exponential ladder in silence. A failure at or
   * above the window (a slow timeout) keeps the full backoff budget.
   */
  export const INSTANT_FAILURE_WINDOW_MS = 2000;
  export const INSTANT_FAILURE_PROBE_DELAY_MS = 250;
  export const INSTANT_FAILURE_STREAK_LIMIT = 3;

  export function isInstantTransportFailure(error: unknown, elapsedMs: number): boolean {
    if (elapsedMs >= INSTANT_FAILURE_WINDOW_MS) return false;
    const providerError = apiCause(error);
    if (providerError === undefined) return false;
    // A status code or response headers prove the endpoint answered — that is
    // an HTTP failure, not a transport one, whatever the timing.
    return (
      providerError.data.isRetryable &&
      providerError.data.statusCode === undefined &&
      providerError.data.responseHeaders === undefined
    );
  }

  /** Consumers branch on this closed vocabulary, never on detail prose. */
  export type Reason =
    | "rate_limit"
    | "overloaded"
    | "server_error"
    | "validation_error"
    | "billing"
    | "content_policy"
    | "non_retryable";
  export type RetryableReason = Exclude<Reason, "non_retryable" | "billing" | "content_policy">;

  export type Decision =
    | {
        readonly retry: true;
        readonly reason: RetryableReason;
        readonly delayMs: number;
        /** An inferred ratelimit reset exceeded the cap and was demoted to backoff. */
        readonly retryAfterOverCap?: boolean;
      }
    | { readonly retry: false; readonly reason: Reason; readonly detail?: string };

  /** Terminal classification precedes probes, headers and backoff. */
  export function decide(
    attempt: number,
    error: unknown,
    instantFailureStreak = 0,
    fallbackAvailable = false,
  ): Decision {
    const providerError = apiCause(error);
    const reason = classify(providerError);
    if (reason === "non_retryable") {
      if (fallbackAvailable && providerError?.data.statusCode === 400)
        return { retry: true, reason: "validation_error", delayMs: 0 };
      return { retry: false, reason };
    }
    if (reason === "billing") {
      return {
        retry: false,
        reason,
        detail:
          "the account's quota or billing balance is exhausted — retrying cannot restore it; top up or raise the limit",
      };
    }
    if (reason === "content_policy") {
      return {
        retry: false,
        reason,
        detail:
          "the provider refused this request on content policy grounds — the same prompt will be refused again; change what is being asked",
      };
    }
    if (instantFailureStreak >= INSTANT_FAILURE_STREAK_LIMIT) {
      return {
        retry: false,
        reason,
        detail: `${instantFailureStreak} consecutive transport failures under ${INSTANT_FAILURE_WINDOW_MS}ms — the endpoint is refusing connections, retrying cannot help`,
      };
    }
    if (instantFailureStreak > 0) {
      return { retry: true, reason, delayMs: INSTANT_FAILURE_PROBE_DELAY_MS };
    }
    return selectDelay(attempt, reason, headerDelay(providerError));
  }

  function selectDelay(
    attempt: number,
    reason: RetryableReason,
    header: ReturnType<typeof headerDelay>,
  ): Decision {
    if (header !== undefined) {
      if (header.ms > RETRY_HEADER_DELAY_CAP) {
        // Explicit directives fail fast; inferred resets demote to backoff.
        if (header.directive) {
          return {
            retry: false,
            reason,
            detail: `server asked to wait ${header.ms}ms, above the ${RETRY_HEADER_DELAY_CAP}ms cap`,
          };
        }
        return { retry: true, reason, delayMs: backoffDelayMs(attempt), retryAfterOverCap: true };
      }
      return { retry: true, reason, delayMs: Math.max(0, header.ms) };
    }
    return { retry: true, reason, delayMs: backoffDelayMs(attempt) };
  }

  /** Jitter subtracts at most one quarter of the ladder delay. */
  export const RETRY_JITTER_RATIO = 0.25;

  /**
   * Jitter applies to the ladder only, never to a server-directed wait: a
   * provider that named a delay gets exactly that delay.
   */
  function backoffDelayMs(attempt: number): number {
    const ladder = Math.min(
      RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    );
    return Math.round(ladder * (1 - Math.random() * RETRY_JITTER_RATIO));
  }

  /** Provider-directed delay retained on the terminal typed failure. */
  export function retryAfterMs(error: unknown): number | undefined {
    const apiError = APIError.isInstance(error) ? error : undefined;
    return headerDelay(apiError)?.ms;
  }

  /** Bound traversal even for cyclic cause chains. */
  const MAX_CAUSE_DEPTH = 8;

  /** Host-facing classification shares the retry decision's provider decoder. */
  export function classifyFailure(error: unknown): Reason {
    return classify(apiCause(error));
  }

  function apiCause(error: unknown): InstanceType<typeof APIError> | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
      const apiError = coerceApiError(current);
      if (apiError !== undefined) return apiError;
      if (typeof current !== "object" || current === null || !("cause" in current)) break;
      const cause = current.cause;
      if (cause === current || cause === undefined) break;
      current = cause;
    }
    return undefined;
  }

  function classify(error: InstanceType<typeof APIError> | undefined): Reason {
    if (error === undefined) {
      return "non_retryable";
    }

    // Billing and moderation outrank the provider's retryable flag.
    if (isBillingExhaustion(error.data.message) || isBillingExhaustion(error.data.responseBody)) {
      return "billing";
    }

    if (
      isContentPolicyRefusal(error.data.statusCode, error.data.message) ||
      isContentPolicyRefusal(error.data.statusCode, error.data.responseBody)
    ) {
      return "content_policy";
    }

    if (!error.data.isRetryable) {
      return "non_retryable";
    }

    const sniffed =
      classifyErrorPayload(error.data.message) ?? classifyErrorPayload(error.data.responseBody);
    if (sniffed !== undefined) {
      return sniffed;
    }

    // Status is the fallback when the payload has no recognized signal.
    const status = error.data.statusCode;
    if (status === 429) {
      return "rate_limit";
    }

    // 5xx, plus the residue the provider marked retryable (408/409,
    // x-should-retry, network failures) without a recognizable class — no
    // consumer distinguishes these, so they share the server_error bucket.
    return "server_error";
  }

  /**
   * Balance exhaustion must be unambiguous: these signals identify a spent
   * account, unlike a provider's billing service outage or a per-minute quota.
   * The check precedes retryability because no wait restores a spent balance.
   */
  const BILLING_PATTERNS = [
    "insufficient_quota",
    "out of budget",
    "monthly usage limit",
    "billing_error",
    "billing required",
    "billing balance",
  ] as const;

  function isBillingExhaustion(payload: string | undefined): boolean {
    if (!payload) return false;
    const haystack = payload.toLowerCase();
    if (BILLING_PATTERNS.some((pattern) => haystack.includes(pattern))) return true;
    // "You exceeded your current quota" and "You exceeded your monthly quota"
    // name an account limit. Do not accept bare "quota exceeded": it can name
    // a short-lived per-minute limit.
    return /exceeded\s+your\s+(?:current|monthly)\s+(?:usage\s+)?quota/.test(haystack);
  }

  /**
   * Moderation verdicts, as the providers name them. Scoped to 4xx: a 5xx
   * merely MENTIONING a content policy (a docs service outage, a moderation
   * backend that fell over) is a server fault and must keep its retries.
   */
  const CONTENT_POLICY_PATTERNS = [
    "content_policy_violation",
    "content_filter",
    "content policy",
    "safety filter",
    "flagged by our moderation",
    "moderation_blocked",
  ] as const;

  function isContentPolicyRefusal(
    statusCode: number | undefined,
    payload: string | undefined,
  ): boolean {
    if (payload === undefined || statusCode === undefined) return false;
    if (statusCode < 400 || statusCode >= 500) return false;
    const haystack = payload.toLowerCase();
    return CONTENT_POLICY_PATTERNS.some((pattern) => haystack.includes(pattern));
  }

  function classifyErrorPayload(payload: string | undefined): RetryableReason | undefined {
    if (!payload) return undefined;

    let body: z.infer<typeof Payload>;
    try {
      body = Payload.parse(JSON.parse(payload));
    } catch {
      return undefined;
    }
    const {
      code,
      error: { type: errorType, code: errorCode, message: errorMessage },
    } = body;

    if (
      body.type === "error" &&
      (errorType === "too_many_requests" ||
        errorType.includes("rate_limit") ||
        errorCode.includes("rate_limit"))
    ) {
      return "rate_limit";
    }

    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "overloaded";
    }

    if (
      errorMessage.includes("no_kv_space") ||
      (body.type === "error" && errorType === "server_error")
    ) {
      return "server_error";
    }

    // A generic error body carries no class of its own — defer to status.
    return undefined;
  }
}
