import { z } from "zod";
import { type ApiFailure, apiFailure, coerceApiError, declaredContextOverflow } from "../error";
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

  const OVERFLOW_PATTERNS = [
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
  ] as const;

  export function isContextOverflow(error: Error): boolean {
    const declared = declaredContextOverflow(error);
    if (declared !== undefined) return declared;
    const message = error.message.toLowerCase();
    return OVERFLOW_PATTERNS.some((pattern) => message.includes(pattern));
  }

  /** Existing placement/agent machine vocabulary, derived beside provider classification. */
  export function attemptReason(
    error: Error,
  ): "timeout" | "transient_error" | "validation_error" | "context_overflow" {
    if (isContextOverflow(error)) return "context_overflow";
    return apiReason(apiCause(error));
  }

  function apiReason(
    api: ApiFailure | undefined,
  ): "timeout" | "transient_error" | "validation_error" {
    if (api === undefined) return "transient_error";
    if (api.data.statusCode === 408) return "timeout";
    return api.data.isRetryable ? "transient_error" : "validation_error";
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

  export function isInstantTransportFailure<E>(error: E, elapsedMs: number): boolean {
    if (elapsedMs >= INSTANT_FAILURE_WINDOW_MS) return false;
    const providerError = apiCause(error);
    return providerError !== undefined && answeredByTransport(providerError.data);
  }

  /** A status code or response headers prove the endpoint answered: HTTP, not transport. */
  function answeredByTransport(data: ApiFailure["data"]): boolean {
    return data.isRetryable && data.statusCode === undefined && data.responseHeaders === undefined;
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
  export function decide<E>(
    attempt: number,
    error: E,
    instantFailureStreak = 0,
    fallbackAvailable = false,
  ): Decision {
    return decideFor(attempt, apiCause(error), instantFailureStreak, fallbackAvailable);
  }

  const TERMINAL_DETAIL = {
    billing:
      "the account's quota or billing balance is exhausted — retrying cannot restore it; top up or raise the limit",
    content_policy:
      "the provider refused this request on content policy grounds — the same prompt will be refused again; change what is being asked",
  } as const;

  function decideFor(
    attempt: number,
    providerError: ApiFailure | undefined,
    instantFailureStreak: number,
    fallbackAvailable: boolean,
  ): Decision {
    const reason = classify(providerError);
    switch (reason) {
      case "non_retryable":
        return nonRetryable(providerError, fallbackAvailable);
      case "billing":
      case "content_policy":
        return { retry: false, reason, detail: TERMINAL_DETAIL[reason] };
      default:
        return retryable(attempt, reason, providerError, instantFailureStreak);
    }
  }

  function retryable(
    attempt: number,
    reason: RetryableReason,
    providerError: ApiFailure | undefined,
    instantFailureStreak: number,
  ): Decision {
    return (
      streakDecision(instantFailureStreak, reason) ??
      selectDelay(attempt, reason, headerDelay(providerError))
    );
  }

  /** A 400 with a fallback candidate is worth one immediate re-route; nothing else is. */
  function nonRetryable(
    providerError: ApiFailure | undefined,
    fallbackAvailable: boolean,
  ): Decision {
    if (fallbackAvailable && providerError?.data.statusCode === 400)
      return { retry: true, reason: "validation_error", delayMs: 0 };
    return { retry: false, reason: "non_retryable" };
  }

  function streakDecision(streak: number, reason: RetryableReason): Decision | undefined {
    if (streak >= INSTANT_FAILURE_STREAK_LIMIT) {
      return {
        retry: false,
        reason,
        detail: `${streak} consecutive transport failures under ${INSTANT_FAILURE_WINDOW_MS}ms — the endpoint is refusing connections, retrying cannot help`,
      };
    }
    return streak > 0
      ? { retry: true, reason, delayMs: INSTANT_FAILURE_PROBE_DELAY_MS }
      : undefined;
  }

  function selectDelay(
    attempt: number,
    reason: RetryableReason,
    header: ReturnType<typeof headerDelay>,
  ): Decision {
    if (header === undefined) return { retry: true, reason, delayMs: backoffDelayMs(attempt) };
    if (header.ms <= RETRY_HEADER_DELAY_CAP)
      return { retry: true, reason, delayMs: Math.max(0, header.ms) };
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
  export function retryAfterMs<E>(error: E): number | undefined {
    return headerDelay(apiFailure(error))?.ms;
  }

  /** Bound traversal even for cyclic cause chains. */
  const MAX_CAUSE_DEPTH = 8;
  const Caused = z.object({ cause: z.instanceof(Object) });

  /** Host-facing classification shares the retry decision's provider decoder. */
  export function classifyFailure<E>(error: E): Reason {
    return classify(apiCause(error));
  }

  function apiCause<E>(error: E): ApiFailure | undefined {
    let current: object | undefined = z.instanceof(Object).safeParse(error).data;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
      const apiError = coerceApiError(current);
      if (apiError !== undefined) return apiError;
      current = nextCause(current);
    }
    return undefined;
  }

  function nextCause(current: object): object | undefined {
    const cause = Caused.safeParse(current).data?.cause;
    return cause === current ? undefined : cause;
  }

  function classify(error: ApiFailure | undefined): Reason {
    if (error === undefined) return "non_retryable";
    // Billing and moderation outrank the provider's retryable flag.
    return terminalClass(error.data) ?? retryableClass(error.data);
  }

  function terminalClass(data: ApiFailure["data"]): Reason | undefined {
    const payloads = [data.message, data.responseBody];
    if (payloads.some(isBillingExhaustion)) return "billing";
    if (payloads.some((payload) => isContentPolicyRefusal(data.statusCode, payload)))
      return "content_policy";
    return data.isRetryable ? undefined : "non_retryable";
  }

  /**
   * Status is the fallback when the payload has no recognized signal: 429 is a
   * rate limit; 5xx plus the residue the provider marked retryable (408/409,
   * x-should-retry, network failures) share the server_error bucket since no
   * consumer distinguishes them.
   */
  function retryableClass(data: ApiFailure["data"]): RetryableReason {
    const sniffed = classifyErrorPayload(data.message) ?? classifyErrorPayload(data.responseBody);
    return sniffed ?? (data.statusCode === 429 ? "rate_limit" : "server_error");
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
    if (payload === undefined || !isClientError(statusCode)) return false;
    const haystack = payload.toLowerCase();
    return CONTENT_POLICY_PATTERNS.some((pattern) => haystack.includes(pattern));
  }

  function isClientError(statusCode: number | undefined): boolean {
    return statusCode !== undefined && statusCode >= 400 && statusCode < 500;
  }

  function classifyErrorPayload(payload: string | undefined): RetryableReason | undefined {
    const body = parsePayload(payload);
    return body === undefined ? undefined : bodyClass(body);
  }

  function bodyClass(body: z.infer<typeof Payload>): RetryableReason | undefined {
    if (isRateLimitBody(body)) return "rate_limit";
    if (isOverloadedBody(body)) return "overloaded";
    // A generic error body carries no class of its own — defer to status.
    return isServerErrorBody(body) ? "server_error" : undefined;
  }

  function isOverloadedBody(body: z.infer<typeof Payload>): boolean {
    return body.code.includes("exhausted") || body.code.includes("unavailable");
  }

  function parsePayload(payload: string | undefined): z.infer<typeof Payload> | undefined {
    if (!payload) return undefined;
    try {
      return Payload.parse(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }

  function isRateLimitBody(body: z.infer<typeof Payload>): boolean {
    if (body.type !== "error") return false;
    const { type, code } = body.error;
    return (
      type === "too_many_requests" || type.includes("rate_limit") || code.includes("rate_limit")
    );
  }

  function isServerErrorBody(body: z.infer<typeof Payload>): boolean {
    return (
      body.error.message.includes("no_kv_space") ||
      (body.type === "error" && body.error.type === "server_error")
    );
  }
}
