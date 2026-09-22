import { Effect, Either } from "effect";
import { expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { alarmFixture } from "./helpers/alarm";
import { alarmSummary } from "./helpers/alarm-payload";
import { runEffect } from "./helpers/effect";


test("monitor budget: N+1 pauses once and only explicit rearm resets the epoch", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const paused = fixture.next("budget", (row) => row.content.includes('"wake_budget"'));
      fixture.arm(
        "budget",
        {
          command: "printf 'one\\ntwo\\nthree\\nfour\\n'",
          description: "budget",
          persistent: true,
        },
        2,
      );
      await runEffect(fixture.worker.start());
      await paused;
      expect(
        fixture
          .rows()
          .map((row) => row.content)
          .slice(0, 2),
      ).toEqual(["one", "two"]);
      expect(fixture.rows()).toHaveLength(3);
      expect(fixture.storage.alarms.get("budget")).toMatchObject({
        status: "paused",
        notifications: 2,
        epoch: 1,
      });
      await runEffect(fixture.worker.tick());
      expect(fixture.rows()).toHaveLength(3);
      const resumed = fixture.next("budget", (row) => row.content === "one");
      Either.getOrThrowWith(
        fixture.run(
          Effect.either(fixture.storage.alarms.rearm("budget", "monitor-session", 1000)),
        ),
        (error) => error,
      );
      await resumed;
      expect(fixture.storage.alarms.get("budget")?.epoch).toBe(2);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));

test("monitor timeout: exact deadline fences source before its exit summary", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const ready = fixture.next("timeout", (row) => row.content === "READY");
      fixture.arm("timeout", {
        command: "printf 'READY\\n'; read value",
        description: "timeout",
        timeout_ms: 50,
      });
      await runEffect(fixture.worker.start());
      await ready;
      fixture.advance(1049);
      await runEffect(fixture.worker.tick());
      expect(fixture.storage.alarms.get("timeout")?.status).toBe("armed");
      const summary = fixture.next("timeout", (row) => row.content.includes('"timeout"'));
      fixture.advance(1050);
      await runEffect(fixture.worker.tick());
      expect(alarmSummary((await summary).content).reason).toBe("timeout");
      expect(fixture.rows()).toHaveLength(2);
      expect(fixture.run(Effect.flip(fixture.storage.alarms.rearm("timeout", "monitor-session", 1050)))._tag).toBe("AlarmRefused");
      await runEffect(fixture.worker.tick());
      expect(fixture.storage.alarms.get("timeout")).toMatchObject({ epoch: 1, status: "fired" });
      expect(fixture.rows()).toHaveLength(2);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));
