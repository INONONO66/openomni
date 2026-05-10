import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { sleep } from "./sleep";

const MAX_API_RETRIES = 3;

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: {
    /** retry-after seconds from 429 body; defaults to 5s */
    parseRetryAfter?: (body: unknown) => number;
    retries?: number;
    label?: string;
  },
): Promise<Response> {
  const retries = options?.retries ?? 0;
  const label = options?.label ?? url;

  const response = await fetch(url, init);

  if (response.status === 429) {
    if (retries >= MAX_API_RETRIES) {
      throw new Error(`${label}: rate limited after ${MAX_API_RETRIES} retries`);
    }

    let retryAfter = 5;
    if (options?.parseRetryAfter) {
      const body = await response.json().catch(() => null);
      if (body !== null) {
        try {
          retryAfter = options.parseRetryAfter(body);
        } catch {
          // parser failed — fall back to default delay
        }
      }
    }

    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "rate limited, retrying",
      context: {
        label,
        retryAfter,
        attempt: retries + 1,
        max: MAX_API_RETRIES,
      },
    });
    await sleep(retryAfter * 1000);

    return fetchWithRetry(url, init, {
      ...options,
      retries: retries + 1,
    });
  }

  return response;
}
