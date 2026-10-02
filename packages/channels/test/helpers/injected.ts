/** Deterministic injected sources for driver tests: fixed clock, sequential UUIDs, zero jitter. */
export const FIXED_NOW = 1_700_000_000_000;

/** UUID-shaped id source: nth call yields `00000000-0000-4000-8000-…n`. */
export function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/** The trace id `newTraceId` derives from the nth sequential UUID. */
export function nthTraceId(n: number): string {
  return `00000000000040008000${String(n).padStart(12, "0")}`;
}

export function injectedOptions(): {
  readonly now: () => number;
  readonly id: () => string;
  readonly random: () => number;
} {
  return { now: () => FIXED_NOW, id: sequentialIds(), random: () => 0 };
}
