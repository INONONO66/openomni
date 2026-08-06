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
