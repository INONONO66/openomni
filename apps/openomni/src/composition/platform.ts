import { randomUUID } from "node:crypto";
import { Clock, Effect, type Layer } from "effect";
import { Entropy, type EntropySource } from "@openomni/agent";

/**
 * The composition root's only ambient entropy (#1245): node's CSPRNG for ids,
 * webcrypto words for uniform randoms. Every other module receives these as
 * required options or through the Entropy service; no `crypto.randomUUID` or
 * `Math.random` read exists outside this file.
 */
export function platformEntropy(): EntropySource {
  return {
    id: () => randomUUID(),
    random: () => {
      const words = new Uint32Array(1);
      crypto.getRandomValues(words);
      return (words[0] ?? 0) / 2 ** 32;
    },
  };
}

/** The app's Entropy layer over the platform source. */
export function platformEntropyLayer(): Layer.Layer<Entropy> {
  return Entropy.layer(platformEntropy());
}

/**
 * Promise-side wall clock, captured ONCE at bootstrap from Effect's default
 * Clock (never re-read ambiently). Effect code keeps using `Clock` directly.
 */
export const captureNow: Effect.Effect<() => number> = Clock.clockWith((clock) =>
  Effect.succeed(() => clock.currentTimeMillisUnsafe()),
);
