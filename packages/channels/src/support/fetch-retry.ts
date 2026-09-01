import { Operational } from "@openomni/protocol";
import type { PublishPort } from "../types";

// merged from sleep.ts (fragment sweep); also consumed by channel pollers
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_API_RETRIES = 3;

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    /** The logical request's trace (D11): every retry of one request shares this ONE id — never re-minted per attempt. */
    traceId: string;
    /** retry-after seconds from 429 body; defaults to 5s */
    parseRetryAfter?: (body: object) => number;
    retries?: number;
    label?: string;
    /** band contract: telemetry goes through the injected observation port */
    publish?: PublishPort;
  },
): Promise<Response> {
  const retries = options.retries ?? 0;
  const label = options.label ?? url;

  const response = await fetch(url, init);

  if (response.status === 429) {
    if (retries >= MAX_API_RETRIES) {
      throw new Error(`${label}: rate limited after ${MAX_API_RETRIES} retries`);
    }

    let retryAfter = 5;
    if (options.parseRetryAfter) {
      const body = (await response.json().catch(() => null)) as object | null;
      if (body !== null) {
        try {
          retryAfter = options.parseRetryAfter(body);
        } catch {
          // parser failed — fall back to default delay
        }
      }
    }

    options.publish?.(Operational.Events.Warn, {
      traceId: options.traceId,
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
