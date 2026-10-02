import { expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { SocketReconnectShell } from "../src/support/socket-shell";
import { testClockRuntime } from "./helpers/effect";
import { FIXED_NOW, sequentialIds } from "./helpers/injected";

const messages = {
  urlFetchFailed: "fetch",
  closed: "closed",
  reconnectFailed: "reconnect",
  socketError: "socket",
};

/**
 * #1248: stop() settles the shell's halt Deferred, which interrupts the
 * reconnect streak's fiber mid-backoff — the first schedule step (~1s) never
 * elapses, so the reconnect callback is never invoked, even when the test
 * clock later advances far past every possible delay. No generation counters:
 * interruption is the custody mechanism.
 */
test("stop() interrupts a pending reconnect mid-backoff; no further attempts", async () => {
  const clock = testClockRuntime();
  let attempts = 0;
  const closedPublished = Promise.withResolvers<void>();
  const shell = new SocketReconnectShell(
    (event) => {
      if (event.name === Operational.Events.Warn.name) closedPublished.resolve();
    },
    messages,
    async () => undefined,
    { now: () => FIXED_NOW, id: sequentialIds(), run: clock.run },
  );
  try {
    shell.begin();
    const streak = shell.scheduleReconnect(4000, async () => {
      attempts += 1;
    });
    // The close Warn publishes synchronously when the streak starts — the
    // exact signal that the backoff sleep is pending on the test clock.
    await closedPublished.promise;
    shell.stop();
    await streak; // the interrupted streak resolves; it does not hang or throw
    await clock.adjust(10 * 60_000); // far past the 60s cap and all ten attempts
    expect(attempts).toBe(0);
    expect(shell.running).toBe(false);
  } finally {
    shell.stop();
    await clock.dispose();
  }
});

/**
 * Companion pin: a streak that is sleeping between attempts (first attempt
 * failed) is equally interruptible — stop() between schedule steps prevents
 * the next attempt.
 */
test("stop() between schedule steps prevents the next attempt", async () => {
  const clock = testClockRuntime();
  let attempts = 0;
  const attemptFailed = Promise.withResolvers<void>();
  const failures: string[] = [];
  const shell = new SocketReconnectShell(
    (event, data) => {
      if (event.name === Operational.Events.Error.name) {
        failures.push(z.object({ msg: z.string() }).parse(data).msg);
        attemptFailed.resolve();
      }
    },
    messages,
    async () => undefined,
    { now: () => FIXED_NOW, id: sequentialIds(), run: clock.run },
  );
  try {
    shell.begin();
    const streak = shell.scheduleReconnect(4000, async () => {
      attempts += 1;
      throw new Error("still down");
    });
    await clock.adjust(1200); // first schedule step (1s jittered, <=1.2s) -> attempt 1
    await attemptFailed.promise;
    expect(attempts).toBe(1);
    shell.stop();
    await streak;
    await clock.adjust(10 * 60_000);
    expect(attempts).toBe(1); // the sleeping retry was interrupted, not resumed
    expect(failures).toEqual(["fetch"]);
  } finally {
    shell.stop();
    await clock.dispose();
  }
});
