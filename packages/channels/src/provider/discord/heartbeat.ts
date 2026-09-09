function intervalWithinBounds(intervalMs: number): number {
  if (intervalMs >= 100 && intervalMs <= 300_000) return intervalMs;
  return intervalMs > 300_000 ? 300_000 : 100;
}

/** The gateway forwards every ACK and closes the watchdog with its socket. */
export class GatewayHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private acknowledged = true;

  constructor(
    private readonly send: () => void,
    private readonly close: () => void,
  ) {}

  start(intervalMs: number): void {
    this.stop();
    this.acknowledged = true;
    this.timer = setInterval(() => {
      if (!this.acknowledged) {
        this.close();
        return;
      }
      this.send();
      this.acknowledged = false;
    }, intervalWithinBounds(intervalMs));
  }

  acknowledge(): void {
    this.acknowledged = true;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
