import { expect, test } from "bun:test";
import { testClockRuntime } from "./helpers/effect";
import { GatewayHeartbeat } from "../src/provider/discord/heartbeat";

/**
 * #1248: the heartbeat watchdog is an Effect loop on the injected clock — no
 * `setInterval`. Every delay below runs on the TestClock; the interval clamp
 * (100ms..300s), the ACK gate, the missed-ACK close, restart, and the
 * stop-interrupt are all pinned by advancing fake time only.
 */
test.each([
  [Number.NaN, 100],
  [-1, 100],
  [0, 100],
  [99, 100],
  [100, 100],
  [500, 500],
  [300_000, 300_000],
  [300_001, 300_000],
  [Number.POSITIVE_INFINITY, 300_000],
])(
  "heartbeat interval %p is bounded to %p and ACK controls the watchdog",
  async (requested, expected) => {
    const clock = testClockRuntime();
    let sent = 0;
    let closed = 0;
    const heartbeat = new GatewayHeartbeat(
      () => {
        sent += 1;
      },
      () => {
        closed += 1;
      },
      clock.run,
    );
    try {
      heartbeat.start(requested);
      await clock.adjust(expected - 1);
      expect(sent).toBe(0); // the clamp decides the deadline, not the raw request
      await clock.adjust(1);
      expect(sent).toBe(1);
      heartbeat.acknowledge();
      await clock.adjust(expected);
      expect(sent).toBe(2);
      expect(closed).toBe(0);
      await clock.adjust(expected); // beat 2 was never ACKed
      expect(closed).toBe(1);
      expect(sent).toBe(2);
      await clock.adjust(expected * 3); // the close ended the loop — no repeat closes
      expect(closed).toBe(1);
      heartbeat.start(requested); // restart installs a fresh watchdog
      await clock.adjust(expected);
      expect(sent).toBe(3);
      heartbeat.stop(); // stop interrupts the sleeping loop mid-interval
      await clock.adjust(expected * 2);
      expect(sent).toBe(3);
      expect(closed).toBe(1);
    } finally {
      heartbeat.stop();
      await clock.dispose();
    }
  },
);
