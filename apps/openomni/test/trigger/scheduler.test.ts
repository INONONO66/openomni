import { describe, expect, test } from "bun:test";
import {
  createTriggerTimerPort,
  type TriggerTimerBackend,
} from "../../src/trigger/scheduler";

interface FakeHandle {
  readonly id: number;
  readonly delay: number;
  readonly callback: () => void;
  cancelled: boolean;
}

function timerRig(now = 1_000) {
  let current = now;
  let issued = 0;
  const handles: FakeHandle[] = [];
  const backend: TriggerTimerBackend = {
    set(delay, callback) {
      const handle: FakeHandle = {
        id: ++issued,
        delay,
        callback,
        cancelled: false,
      };
      handles.push(handle);
      return handle;
    },
    clear(value) {
      (value as FakeHandle).cancelled = true;
    },
  };
  return {
    clock: { now: () => current },
    backend,
    handles,
    setNow(value: number) {
      current = value;
    },
    fire(handle: FakeHandle) {
      handle.callback();
    },
  };
}

describe("Trigger deadline timer", () => {
  test("replaces one key and rejects the stale generation callback", () => {
    const rig = timerRig();
    const timer = createTriggerTimerPort(rig.clock, rig.backend, { maxDelayMs: 1_000 });
    const fired: string[] = [];

    timer.arm("trigger-1", 1_500, () => fired.push("old"));
    const old = rig.handles[0];
    if (old === undefined) throw new Error("missing first timer handle");
    timer.arm("trigger-1", 1_250, () => fired.push("new"));
    const current = rig.handles[1];
    if (current === undefined) throw new Error("missing replacement timer handle");

    expect(old.cancelled).toBe(true);
    rig.setNow(2_000);
    rig.fire(old);
    expect(fired).toEqual([]);
    rig.fire(current);
    expect(fired).toEqual(["new"]);
  });

  test("chains long deadlines and re-reads the clock before firing", () => {
    const rig = timerRig(100);
    const timer = createTriggerTimerPort(rig.clock, rig.backend, { maxDelayMs: 1_000 });
    let fired = 0;

    timer.arm("long", 2_600, () => {
      fired += 1;
    });
    expect(rig.handles[0]?.delay).toBe(1_000);

    rig.setNow(1_100);
    const first = rig.handles[0];
    if (first === undefined) throw new Error("missing first segment");
    rig.fire(first);
    expect(rig.handles[1]?.delay).toBe(1_000);
    expect(fired).toBe(0);

    rig.setNow(2_100);
    const second = rig.handles[1];
    if (second === undefined) throw new Error("missing second segment");
    rig.fire(second);
    expect(rig.handles[2]?.delay).toBe(500);

    rig.setNow(2_600);
    const final = rig.handles[2];
    if (final === undefined) throw new Error("missing final segment");
    rig.fire(final);
    expect(fired).toBe(1);
  });

  test("a wall-clock rollback never lengthens logical history or fires early", () => {
    const rig = timerRig(5_000);
    const rollbacks: Array<{ rawNow: number; logicalNow: number }> = [];
    const timer = createTriggerTimerPort(rig.clock, rig.backend, {
      maxDelayMs: 1_000,
      onClockRollback: ({ rawNow, logicalNow }) => rollbacks.push({ rawNow, logicalNow }),
    });
    let fired = false;

    timer.arm("rollback", 6_500, () => {
      fired = true;
    });
    rig.setNow(4_000);
    const segment = rig.handles[0];
    if (segment === undefined) throw new Error("missing segment");
    rig.fire(segment);

    expect(rollbacks).toEqual([{ rawNow: 4_000, logicalNow: 5_000 }]);
    expect(rig.handles[1]?.delay).toBe(1_000);
    expect(fired).toBe(false);
  });

  test("cancelAll invalidates every outstanding callback", () => {
    const rig = timerRig();
    const timer = createTriggerTimerPort(rig.clock, rig.backend);
    let fired = 0;
    timer.arm("a", 2_000, () => {
      fired += 1;
    });
    timer.arm("b", 2_000, () => {
      fired += 1;
    });
    timer.cancelAll();
    rig.setNow(3_000);
    for (const handle of rig.handles) rig.fire(handle);
    expect(fired).toBe(0);
    expect(rig.handles.every((handle) => handle.cancelled)).toBe(true);
  });
});
