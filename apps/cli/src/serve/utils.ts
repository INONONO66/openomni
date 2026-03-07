// ---------------------------------------------------------------------------
// Shared adapter utilities
// ---------------------------------------------------------------------------

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split text into chunks respecting a max length, preferring line boundaries.
 * Falls back to hard-split when no suitable newline is found.
 */
export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

const MAX_API_RETRIES = 3;

/**
 * Fetch with automatic 429 retry and bounded retries.
 * Throws after MAX_API_RETRIES consecutive rate-limit responses.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: {
    /** Extract retry-after seconds from the 429 response body. Default: 5s. */
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
      throw new Error(
        `${label}: rate limited after ${MAX_API_RETRIES} retries`,
      );
    }

    let retryAfter = 5;
    if (options?.parseRetryAfter) {
      try {
        const body = await response.json();
        retryAfter = options.parseRetryAfter(body);
      } catch {
        // fallback to default
      }
    }

    console.warn(
      `[${label}] Rate limited, retrying in ${retryAfter}s (${retries + 1}/${MAX_API_RETRIES})`,
    );
    await sleep(retryAfter * 1000);

    return fetchWithRetry(url, init, {
      ...options,
      retries: retries + 1,
    });
  }

  return response;
}
