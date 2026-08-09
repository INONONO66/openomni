import { APIError } from "../error";

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

  /**
   * Server-directed waits above this cap fail fast instead of silently
   * stalling a run mid-flight: the headless backoff already tops out at 30s,
   * so a server asking for more than twice that budget surfaces as a visible
   * failure whose retry policy belongs to the caller.
   */
  export const RETRY_HEADER_DELAY_CAP = 60_000;

  export type Decision =
    | {
        readonly retryable: true;
        readonly reason: string;
        readonly delayMs: number;
        readonly source: "header" | "backoff";
      }
    | { readonly retryable: false; readonly reason: string };

  /**
   * Typed retry decision (#532 candidate 3): classification + delay in one
   * call, failing fast when the server asks for a wait above the cap.
   */
  export function decide(attempt: number, error: unknown): Decision {
    const reason = isRetryable(error);
    if (reason === undefined) {
      return { retryable: false, reason: "non_retryable" };
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
            retryable: false,
            reason: `${reason}: server asked to wait ${header.ms}ms, above the ${RETRY_HEADER_DELAY_CAP}ms cap`,
          };
        }
        return { retryable: true, reason, delayMs: backoffDelayMs(attempt), source: "backoff" };
      }
      return { retryable: true, reason, delayMs: Math.max(0, header.ms), source: "header" };
    }
    return { retryable: true, reason, delayMs: backoffDelayMs(attempt), source: "backoff" };
  }

  export function delay(
    attempt: number,
    error?: InstanceType<typeof APIError>,
    initialDelay?: number,
  ): number {
    const header = headerDelay(error);
    if (header !== undefined) {
      return header.ms;
    }
    return backoffDelayMs(attempt, initialDelay);
  }

  function backoffDelayMs(attempt: number, initialDelay?: number): number {
    const baseDelay = initialDelay ?? RETRY_INITIAL_DELAY;
    return Math.min(baseDelay * RETRY_BACKOFF_FACTOR ** (attempt - 1), RETRY_MAX_DELAY_NO_HEADERS);
  }

  /** directive: an explicit server instruction (retry-after) vs an inferred
   * wait from ratelimit reset metadata. */
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

  export function isRetryable(error: unknown): string | undefined {
    if (!APIError.isInstance(error)) {
      return undefined;
    }

    if (!error.data.isRetryable) {
      return undefined;
    }

    const sniffed =
      classifyErrorPayload(error.data.message) ?? classifyErrorPayload(error.data.responseBody);
    if (sniffed !== undefined) {
      return sniffed;
    }

    const status = error.data.statusCode;
    if (status === 429) {
      return "Rate Limited";
    }
    if (status !== undefined && status >= 500) {
      return "Provider Server Error";
    }

    // The provider marked this retryable (408/409, x-should-retry, …) even
    // though the payload carries no recognizable detail.
    return "Provider Error";
  }

  function classifyErrorPayload(payload: string | undefined): string | undefined {
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
    const errorCode = typeof body.error?.code === "string" ? body.error.code : "";
    const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";

    if (body.type === "error" && body.error?.type === "too_many_requests") {
      return "Too Many Requests";
    }

    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded";
    }

    if (body.type === "error" && errorCode.includes("rate_limit")) {
      return "Rate Limited";
    }

    if (
      errorMessage.includes("no_kv_space") ||
      (body.type === "error" && body.error?.type === "server_error") ||
      !!body.error
    ) {
      return "Provider Server Error";
    }

    return undefined;
  }
}
