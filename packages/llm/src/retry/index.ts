import { APIError } from "../error";

export namespace Retry {
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
    if (!APIError.isInstance(error)) return false;
    // A status code or response headers prove the endpoint answered — that is
    // an HTTP failure, not a transport one, whatever the timing.
    return (
      error.data.isRetryable &&
      error.data.statusCode === undefined &&
      error.data.responseHeaders === undefined
    );
  }

  /**
   * The retry vocabulary (#532 candidate 3). Every member has a producing
   * branch in classify() and a consuming case in the processor's typed
   * switch — reasons are branched on as literals, never as prose. Human
   * prose lives only in Decision.detail.
   */
  export type Reason = "rate_limit" | "overloaded" | "server_error" | "non_retryable";
  export type RetryableReason = Exclude<Reason, "non_retryable">;

  export type Decision =
    | {
        readonly retry: true;
        readonly reason: RetryableReason;
        readonly delayMs: number;
        /** An inferred ratelimit reset exceeded the cap and was demoted to backoff. */
        readonly retryAfterOverCap?: boolean;
      }
    | { readonly retry: false; readonly reason: Reason; readonly detail?: string };

  /**
   * Typed retry decision (#532 candidate 3): classification + delay in one
   * call, failing fast when the server asks for a wait above the cap.
   */
  export function decide(attempt: number, error: unknown, instantFailureStreak = 0): Decision {
    const reason = classify(error);
    if (reason === "non_retryable") {
      return { retry: false, reason };
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
    const apiError = APIError.isInstance(error) ? error : undefined;
    const header = headerDelay(apiError);
    if (header !== undefined) {
      if (header.ms > RETRY_HEADER_DELAY_CAP) {
        // Only an explicit retry-after directive fails fast; an out-of-range
        // ratelimit reset is an inference we made, so it demotes to backoff
        // rather than killing the run.
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

  function backoffDelayMs(attempt: number): number {
    return Math.min(
      RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    );
  }

  /** Provider-directed delay retained on the terminal typed failure. */
  export function retryAfterMs(error: unknown): number | undefined {
    const apiError = APIError.isInstance(error) ? error : undefined;
    return headerDelay(apiError)?.ms;
  }

  /** Directive: explicit retry-after vs an inferred ratelimit reset. */
  function headerDelay(
    error?: InstanceType<typeof APIError>,
  ): { ms: number; directive: boolean } | undefined {
    const headers = error?.data.responseHeaders;
    if (!headers) return undefined;

    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs) {
      const parsedMs = Number.parseFloat(retryAfterMs);
      if (!Number.isNaN(parsedMs)) {
        return { ms: parsedMs, directive: true };
      }
    }

    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const parsedSeconds = Number.parseFloat(retryAfter);
      if (!Number.isNaN(parsedSeconds)) {
        return { ms: Math.ceil(parsedSeconds * 1000), directive: true };
      }
      const parsed = Date.parse(retryAfter) - Date.now();
      if (!Number.isNaN(parsed) && parsed > 0) {
        return { ms: Math.ceil(parsed), directive: true };
      }
    }

    // Structured ratelimit resets are the fallback signal when retry-after is
    // absent: Anthropic sends RFC3339 timestamps, OpenAI sends Go-style
    // durations ("1s", "1m30s"). Take the earliest reset across buckets.
    let earliest: number | undefined;
    for (const [name, value] of Object.entries(headers)) {
      if (!/^(anthropic-ratelimit|x-ratelimit)-.*reset/.test(name)) continue;
      const ms = parseResetValue(value);
      if (ms === undefined) continue;
      if (earliest === undefined || ms < earliest) earliest = ms;
    }
    return earliest === undefined ? undefined : { ms: earliest, directive: false };
  }

  function parseResetValue(value: string): number | undefined {
    // Durations before Date.parse: a bare number like "2027" would otherwise
    // parse as a year.
    const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value.trim());
    if (duration && duration[0] !== "") {
      const [, h, m, s, ms] = duration;
      if (h !== undefined || m !== undefined || s !== undefined || ms !== undefined) {
        return (
          Number(h ?? 0) * 3_600_000 +
          Number(m ?? 0) * 60_000 +
          Math.ceil(Number(s ?? 0) * 1000) +
          Number(ms ?? 0)
        );
      }
    }
    if (!/[-T:]/.test(value)) return undefined; // timestamps only — never bare numbers
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
      const ms = asDate - Date.now();
      return ms > 0 ? Math.ceil(ms) : undefined;
    }
    return undefined;
  }

  function classify(error: unknown): Reason {
    if (!APIError.isInstance(error)) {
      return "non_retryable";
    }

    if (!error.data.isRetryable) {
      return "non_retryable";
    }

    const sniffed =
      classifyErrorPayload(error.data.message) ?? classifyErrorPayload(error.data.responseBody);
    if (sniffed !== undefined) {
      return sniffed;
    }

    // Status outranks a payload the sniffer found no specific signal in: an
    // Anthropic 429 body ({error:{type:"rate_limit_error"}}) must classify as
    // a rate limit, not fall into the generic server-error bucket.
    const status = error.data.statusCode;
    if (status === 429) {
      return "rate_limit";
    }

    // 5xx, plus the residue the provider marked retryable (408/409,
    // x-should-retry, network failures) without a recognizable class — no
    // consumer distinguishes these, so they share the server_error bucket.
    return "server_error";
  }

  function classifyErrorPayload(payload: string | undefined): RetryableReason | undefined {
    if (!payload) return undefined;

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return undefined;
    }

    if (!json || typeof json !== "object") {
      return undefined;
    }

    const body = json as {
      type?: unknown;
      code?: unknown;
      error?: { type?: unknown; code?: unknown; message?: unknown };
    };
    const code = typeof body.code === "string" ? body.code : "";
    const errorType = typeof body.error?.type === "string" ? body.error.type : "";
    const errorCode = typeof body.error?.code === "string" ? body.error.code : "";
    const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";

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
