import { Deferred, Effect, Exit } from "effect";
import type { EffectRunner } from "../../types";

function intervalWithinBounds(intervalMs: number): number {
  if (intervalMs >= 100 && intervalMs <= 300_000) return intervalMs;
  return intervalMs > 300_000 ? 300_000 : 100;
}

/**
 * Discord heartbeat watchdog as an Effect loop (#1248): every bounded
 * interval on the injected clock, a missed ACK closes the socket and ends the
 * loop; an ACKed interval sends the next beat. The gateway forwards every ACK
 * and stops the watchdog with its socket; `stop` settles the halt Deferred,
 * which interrupts the sleeping loop through `Effect.raceFirst` — no timer handles.
 */
export class GatewayHeartbeat {
  private halt: Deferred.Deferred<void> | null = null;
  private acknowledged = true;

  constructor(
    private readonly send: () => void,
    private readonly close: () => void,
    private readonly run: EffectRunner,
  ) {}

  start(intervalMs: number): void {
    this.stop();
    this.acknowledged = true;
    const halt = Deferred.makeUnsafe<void>();
    this.halt = halt;
    const beat = Effect.suspend(() => {
      if (!this.acknowledged) {
        this.close();
        return Deferred.done(halt, Exit.void);
      }
      this.send();
      this.acknowledged = false;
      return Effect.void;
    });
    const loop = beat.pipe(Effect.delay(intervalWithinBounds(intervalMs)), Effect.forever);
    void this.run(Effect.raceFirst(loop, Deferred.await(halt)));
  }

  acknowledge(): void {
    this.acknowledged = true;
  }

  stop(): void {
    if (this.halt !== null) {
      Deferred.doneUnsafe(this.halt, Exit.void);
      this.halt = null;
    }
  }
}
