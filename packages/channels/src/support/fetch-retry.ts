import { RateLimited } from "../errors";
import { Operational } from "@openomni/protocol";
import type { z } from "zod";
import type { PublishPort } from "../types";

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
    retryAfterSchema?: z.ZodType<number>;
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
      throw new RateLimited({
        message: `${label}: rate limited after ${retries} retries`,
        status: response.status,
        attempts: retries + 1,
        responseHeaders: Object.fromEntries(response.headers),
        responseBody: await response.text(),
      });
    }

    let retryAfter = 5;
    if (options.retryAfterSchema) {
      const parsed = options.retryAfterSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success) retryAfter = parsed.data;
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
