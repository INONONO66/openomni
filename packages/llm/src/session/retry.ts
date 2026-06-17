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
    } catch (error) {
      if (error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }
}
