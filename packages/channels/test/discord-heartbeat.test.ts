import { expect, spyOn, test } from "bun:test";
import { GatewayHeartbeat } from "../src/provider/discord/heartbeat";

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
])("heartbeat interval %s is bounded to %s and ACK controls the watchdog", (requested, expected) => {
  const handle = setInterval(() => undefined, 1000);
  clearInterval(handle);
  let tick: () => void = () => {
    throw new Error("heartbeat interval was not installed");
  };
  const periods: number[] = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (callback: Parameters<typeof setInterval>[0], period?: number) => {
      periods.push(period ?? 0);
      tick = () => callback();
      return handle;
    },
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
  let sent = 0;
  let closed = 0;
  const heartbeat = new GatewayHeartbeat(
    () => {
      sent += 1;
    },
    () => {
      closed += 1;
    },
  );
  try {
    heartbeat.start(requested);
    tick();
    heartbeat.acknowledge();
    tick();
    expect(sent).toBe(2);
    expect(closed).toBe(0);
    tick();
    expect(closed).toBe(1);
    expect(sent).toBe(2);
    heartbeat.start(requested);
    tick();
    expect(sent).toBe(3);
    expect(periods).toEqual([expected, expected]);
    expect(clear).toHaveBeenCalledWith(handle);
    heartbeat.stop();
    expect(clear).toHaveBeenCalledTimes(2);
  } finally {
    heartbeat.stop();
    interval.mockRestore();
    clear.mockRestore();
  }
});
