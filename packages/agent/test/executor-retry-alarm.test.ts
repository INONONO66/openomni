import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { createRetryAlarmPort } from "../src/executor-retry-alarm";
import { requestLedger } from "./helpers/request-ledger";

const clock = () => 100;
const schedule = { id: "retry-1", attempt: 1, reason: "transient_error", fireAt: 150 };

const materialize = (id: string) => requestLedger({ id, clock });

describe("retry alarm port over the single alarm owner", () => {
  beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
  afterEach(() => Storage.reset());

  test("arm commits the retry.scheduled row for a live session", () => {
    materialize("arm-session");
    createRetryAlarmPort("arm-session", clock).arm(schedule);
    expect(Storage.get().alarms?.get("retry-1")).toMatchObject({
      id: "retry-1",
      sessionId: "arm-session",
      kind: "at",
      status: "armed",
      fireAt: 150,
    });
  });

  test("a refused arm throws instead of silently continuing, and no row is written", () => {
    expect(() => createRetryAlarmPort("missing-session", clock).arm(schedule)).toThrow(
      "alarm arm refused: retry-1",
    );
    expect(Storage.get().alarms?.get("retry-1")).toBeUndefined();
  });

  test("settle consumes the armed row through the fenced cancel", () => {
    materialize("settle-session");
    const port = createRetryAlarmPort("settle-session", clock);
    port.arm(schedule);
    port.settle("retry-1");
    expect(Storage.get().alarms?.get("retry-1")).toMatchObject({ status: "cancelled" });
  });

  test("wait resolves at the schedule instant and never before the clock reaches it", async () => {
    let now = 100;
    const port = createRetryAlarmPort("wait-session", () => now);
    now = 150;
    await port.wait(150, new AbortController().signal);
  });

  test("the port fails closed when alarm storage is absent", () => {
    Storage.reset();
    Storage.configure({ transaction: <T>(operation: () => T): T => operation() });
    expect(() => createRetryAlarmPort("s", clock).arm(schedule)).toThrow(
      "L0 storage capability is unavailable: alarms",
    );
  });
});
