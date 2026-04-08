export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
