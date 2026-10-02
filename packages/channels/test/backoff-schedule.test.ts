import { expect, test } from "bun:test";
import { Duration, Effect, Schedule } from "effect";
import { runEffect } from "./helpers/effect";
import { RECONNECT_ATTEMPT_BOUND, reconnectSchedule } from "../src/support/schedule";

/**
 * #1248: the shared reconnect policy is a composed `Schedule`, not hand-rolled
 * math — exponential from 1s, capped at 60s by `Schedule.min` with the spaced
 * schedule, ±20% jitter from the Effect Random service. The schedule is
 * stepped directly (`Schedule.toStep`), so the pin needs no clock and holds
 * under any jitter seed.
 */
test("reconnect schedule: exponential from 1s, 60s cap, ±20% jitter, bounded attempts", async () => {
  const delays = await runEffect(
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(reconnectSchedule);
      const out: number[] = [];
      for (let attempt = 0; attempt < RECONNECT_ATTEMPT_BOUND; attempt++) {
        const [, delay] = yield* step(0, undefined);
        out.push(Duration.toMillis(delay));
      }
      return out;
    }),
  );
  expect(delays).toHaveLength(RECONNECT_ATTEMPT_BOUND);
  delays.forEach((delay, index) => {
    const base = Math.min(1000 * 2 ** index, 60_000);
    expect(delay).toBeGreaterThanOrEqual(base * 0.8);
    expect(delay).toBeLessThanOrEqual(base * 1.2);
  });
  // The supervisor bound stays a small finite streak — driver death is observable, not an endless loop.
  expect(RECONNECT_ATTEMPT_BOUND).toBe(10);
});
