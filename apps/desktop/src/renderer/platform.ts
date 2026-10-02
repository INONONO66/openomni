/**
 * The renderer's clock and entropy, built ONCE at bootstrap (#1245) from host
 * objects passed by value. Everything below the entry file receives this value
 * through props or options; no module under `renderer/` reads the ambient
 * `Date` or `crypto` itself.
 */
export interface RendererPlatform {
  /** Wall-clock milliseconds. */
  readonly now: () => number;
  /** A fresh unique identifier. */
  readonly id: () => string;
}

export function createPlatform(host: {
  readonly clock: { now(): number };
  readonly ids: { randomUUID(): string };
}): RendererPlatform {
  return {
    now: () => host.clock.now(),
    id: () => host.ids.randomUUID(),
  };
}
