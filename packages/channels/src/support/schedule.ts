import { Schedule } from "effect";

/**
 * Shared reconnect schedule (discord gateway, slack Socket Mode, telegram
 * poll errors): exponential from 1s, capped by the 60s spaced schedule
 * (`Schedule.min` picks the lesser interval — this Effect pin has no
 * `Schedule.either`), with ±20% jitter so multiple surfaces never
 * thundering-herd a platform after one network blip. Jitter draws from the
 * Effect Random service, so tests stay deterministic under a provided seed
 * and TestClock owns every delay.
 */
export const reconnectSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("60 seconds"),
]).pipe(Schedule.jittered);

/**
 * Supervisor bound for one reconnect streak: after this many consecutive
 * failed attempts the driver stops retrying and reports a typed failure —
 * driver death must surface as `not_sent|unknown` sends plus an Owner
 * notice, never an unbounded silent retry loop. Composed with
 * `reconnectSchedule` via `Effect.retry`'s policy options (the v4 form of
 * `Schedule.recurs(n)` intersection).
 */
export const RECONNECT_ATTEMPT_BOUND = 10;
