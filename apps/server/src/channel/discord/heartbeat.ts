import { GatewayOp } from "./types";

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ackReceived = true;

  start(
    intervalMs: number,
    send: (payload: Record<string, unknown>) => void,
    getSequence: () => number | null,
    onMissedAck: () => void,
  ): void {
    this.stop();
    this.ackReceived = true;
    this.timer = setInterval(() => {
      if (!this.ackReceived) {
        onMissedAck();
        return;
      }
      send({ op: GatewayOp.HEARTBEAT, d: getSequence() });
      this.ackReceived = false;
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  ack(): void {
    this.ackReceived = true;
  }
}
