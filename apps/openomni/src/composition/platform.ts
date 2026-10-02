import { randomUUID } from "node:crypto";
import { Clock, Effect, Layer } from "effect";
import { type Kernel, Session } from "@openomni/agent";
type EntropySource = Kernel.EntropySource;
const createObservationBus = Session.createObservationBus;

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

/**
 * Promise-side wall clock, captured ONCE at bootstrap from Effect's default
 * Clock (never re-read ambiently). Effect code keeps using `Clock` directly.
 */
export const captureNow: Effect.Effect<() => number> = Clock.clockWith((clock) =>
  Effect.succeed(() => clock.currentTimeMillisUnsafe()),
);

/**
 * The process default observation bus (replaces the deleted agent `Bus`
 * singleton): the supplied entropy mints event ids and the injected `now`
 * stamps their times. Compositions that need isolation pass their own bus
 * through `AppRuntimeOptions.observations`.
 */
export function platformBus(entropy: EntropySource, now: () => number): ReturnType<typeof createObservationBus> {
  return createObservationBus({ id: entropy.id, now });
}

/**
 * An Effect Clock whose wall-time reads come from the injected `now` while
 * sleeps and monotonic reads keep the `base` clock's behavior — the seam
 * tests use to pin deterministic time over a whole app runtime.
 */
function wallClockOverride(now: () => number, base: Clock.Clock): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => now(),
    currentTimeMillis: Effect.sync(() => now()),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };
}

/** The Clock layer `AppLive` mounts when composition injects `now`. */
export function wallClockLayer(now: () => number): Layer.Layer<never> {
  return Layer.effect(Clock.Clock, Clock.clockWith((base) => Effect.succeed(wallClockOverride(now, base))));
}
