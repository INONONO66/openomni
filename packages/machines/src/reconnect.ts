/**
 * Daemon reconnect state machine (#1270). Pure scheduling policy with
 * INJECTED time and randomness: nothing here reads a clock, sleeps, or spins.
 * The daemon owns what an attempt does; this module owns when one happens.
 */

/** Injected timer: schedule returns the cancellation for that one task. */
interface ReconnectScheduler {
  schedule(delayMs: number, task: () => void): () => void;
}

export interface ReconnectOptions {
  readonly scheduler: ReconnectScheduler;
  /** Injected jitter source in [0, 1): full jitter multiplies the ceiling. */
  readonly random: () => number;
}

/** Full-jitter exponential backoff: base 250 ms doubling to a 30 s ceiling. */
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_CAP_DELAY_MS = 30_000;

function fullJitterDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_CAP_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface Reconnector {
  /** Schedules the next attempt; one is live at a time, none after stop(). */
  scheduleAttempt(): void;
  /** A successful attach resets the attempt counter to the base delay. */
  reset(): void;
  /** Cancels the scheduled attempt (if any) and refuses future scheduling. */
  stop(): void;
}

export function createReconnector(options: ReconnectOptions, attempt: () => void): Reconnector {
  let attempts = 0;
  let cancel: (() => void) | undefined;
  let stopped = false;
  return {
    scheduleAttempt() {
      if (stopped || cancel !== undefined) return;
      const delay = fullJitterDelayMs(attempts, options.random);
      attempts += 1;
      cancel = options.scheduler.schedule(delay, () => { cancel = undefined; attempt(); });
    },
    reset() { attempts = 0; },
    stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
    },
  };
}
