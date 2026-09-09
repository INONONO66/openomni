import type { APIError } from "../error";

type Delay = { ms: number; directive: boolean };

/** Explicit directives outrank inferred reset buckets. */
export function headerDelay(error?: InstanceType<typeof APIError>): Delay | undefined {
  const headers = error?.data.responseHeaders;
  if (headers === undefined) return undefined;
  const milliseconds = Number.parseFloat(headers["retry-after-ms"] ?? "");
  if (!Number.isNaN(milliseconds)) return { ms: milliseconds, directive: true };
  const retryAfter = retryAfterDelay(headers["retry-after"]);
  if (retryAfter !== undefined) return { ms: retryAfter, directive: true };
  return resetDelay(headers);
}

function retryAfterDelay(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (!Number.isNaN(seconds)) return Math.ceil(seconds * 1000);
  return futureTimestamp(value);
}

function futureTimestamp(value: string): number | undefined {
  const ms = Date.parse(value) - Date.now();
  return ms > 0 ? Math.ceil(ms) : undefined;
}

function resetDelay(headers: Record<string, string>): Delay | undefined {
  const resets = Object.entries(headers)
    .filter(([name]) => /^(anthropic-ratelimit|x-ratelimit)-.*reset/.test(name))
    .map(([, value]) => parseResetValue(value))
    .filter((ms): ms is number => ms !== undefined);
  return resets.length === 0 ? undefined : { ms: Math.min(...resets), directive: false };
}

function parseResetValue(value: string): number | undefined {
  const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value.trim());
  if (duration && duration[0] !== "") return durationMilliseconds(duration);
  // Bare numbers are not timestamps (Date.parse would accept them as years).
  return /[-T:]/.test(value) ? futureTimestamp(value) : undefined;
}

function durationMilliseconds(match: RegExpExecArray): number {
  const [, h = "0", m = "0", s = "0", ms = "0"] = match;
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Math.ceil(Number(s) * 1000) + Number(ms);
}
