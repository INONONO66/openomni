import type { ApiFailure } from "../error";

type Delay = { ms: number; directive: boolean };

/** Explicit directives outrank inferred reset buckets. */
export function headerDelay(error?: ApiFailure): Delay | undefined {
  const headers = error?.data.responseHeaders;
  if (headers === undefined) return undefined;
  const directive = directiveDelay(headers);
  return directive === undefined ? resetDelay(headers) : { ms: directive, directive: true };
}

function directiveDelay(headers: Record<string, string>): number | undefined {
  const milliseconds = Number.parseFloat(headers["retry-after-ms"] ?? "");
  return Number.isNaN(milliseconds) ? retryAfterDelay(headers["retry-after"]) : milliseconds;
}

function retryAfterDelay(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  return Number.isNaN(seconds) ? futureTimestamp(value) : Math.ceil(seconds * 1000);
}

function futureTimestamp(value: string): number | undefined {
  const ms = Date.parse(value) - Date.now();
  return ms > 0 ? Math.ceil(ms) : undefined;
}

function resetDelay(headers: Record<string, string>): Delay | undefined {
  const resets = Object.entries(headers)
    .filter(([name]) => /^(anthropic-ratelimit|x-ratelimit)-.*reset/.test(name))
    .map(([, value]) => parseResetValue(value))
    .filter((reset) => reset !== undefined);
  return resets.length === 0 ? undefined : { ms: Math.min(...resets), directive: false };
}

function parseResetValue(value: string): number | undefined {
  const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value.trim());
  if (duration && duration[0] !== "") return durationMilliseconds(duration);
  // Bare numbers are not timestamps (Date.parse would accept them as years).
  return /[-T:]/.test(value) ? futureTimestamp(value) : undefined;
}

const DURATION_UNIT_MS = [3_600_000, 60_000, 1000, 1] as const;

function durationMilliseconds(match: RegExpExecArray): number {
  return DURATION_UNIT_MS.reduce(
    (total, unit, index) => total + Math.ceil(Number(match[index + 1] ?? "0") * unit),
    0,
  );
}
