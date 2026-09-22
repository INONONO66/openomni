import { Effect } from "effect";
import { expect, jest, spyOn, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { L0Observation } from "@openomni/protocol";
import { alarmWorkerFixture, alarmFixture } from "./helpers/alarm";
import { bounded } from "./helpers/protected-dispatch";
import { runEffect } from "./helpers/effect";

test("bus scan exceptions are reported without escaping the publication", () =>
  Storage.withIsolation(async () => {
    const reported = Promise.withResolvers<Error>();
    const fixture = alarmFixture(":memory:", reported.resolve);
    await runEffect(fixture.worker.start());
    const due = spyOn(fixture.storage.alarms, "due").mockImplementation(() => {
      throw new Error("SCAN_FAULT");
    });
    try {
      fixture.events.publish(L0Observation.ActionCommittedEvent, {
        id: "scan",
        sessionId: "monitor-session",
        revision: 1,
        kind: "alarm.arm",
      });
      expect(await bounded(reported.promise)).toMatchObject({ site: "bus.scan" });
      expect(fixture.errors).toHaveLength(1);
    } finally {
      due.mockRestore();
      await fixture.close();
    }
  }));

test("the default periodic scan runs at one second and contains timer failures", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    const errors: Error[] = [];
    const reported = Promise.withResolvers<Error>();
    const worker = alarmWorkerFixture({
      alarms: fixture.storage.alarms,
      observations: fixture.events,
      clock: () => 1000,
      requestTimeout: () => Effect.void,
      wake: () => Effect.void,
      failure: (error) => {
        errors.push(error);
        reported.resolve(error);
      },
    });
    jest.useFakeTimers();
    await runEffect(worker.worker.start());
    const due = spyOn(fixture.storage.alarms, "due").mockImplementation(() => {
      throw new Error("SCAN_FAULT");
    });
    try {
      jest.advanceTimersByTime(999);
      expect(errors).toEqual([]);
      jest.advanceTimersByTime(1);
      jest.useRealTimers();
      expect(await bounded(reported.promise)).toMatchObject({ site: "timer.scan" });
      expect(errors).toHaveLength(1);
    } finally {
      due.mockRestore();
      await worker.close();
      jest.useRealTimers();
      await fixture.close();
    }
  }));

test("a physical source close rejection is tracked and reported during shutdown", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    const first = fixture.next("close-fault");
    fixture.arm("close-fault", {
      command: "printf 'READY\\n'; read hold",
      description: "close fault",
      persistent: true,
    });
    await runEffect(fixture.worker.start());
    await first;
    const fault = new Error("CLOSE_FAULT");
    const original = Bun.Terminal.prototype.close;
    let failed = false;
    const close = spyOn(Bun.Terminal.prototype, "close").mockImplementation(function (
      this: Bun.Terminal,
    ) {
      original.call(this);
      if (!failed) {
        failed = true;
        throw fault;
      }
    });
    try {
      const result = await runEffect(Effect.either(fixture.worker.close()));
      expect(result).toMatchObject({ _tag: "Left", left: fault });
    } finally {
      close.mockRestore();
      await fixture.close();
    }
  }));
