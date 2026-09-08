import { expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { Alarm, canonicalDigest } from "@openomni/protocol";
import { alarmFixture } from "./helpers/alarm";

const watch: Alarm.Watch = { command: "true", description: "occurrence", persistent: true };

test("two matches are two occurrences; redelivering one committed occurrence commits zero", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      fixture.arm("poll", watch);
      const owned = fixture.storage.alarms.acquire("poll", 0);
      if (owned === undefined) throw new Error("acquire refused");
      const fire = (sourceKey: string, content: string) =>
        fixture.storage.alarms.fire({
          id: "poll",
          epoch: owned.epoch,
          fence: owned.fence,
          sourceKey,
          at: 1000,
          content,
          batchHash: canonicalDigest(content),
          terminal: false,
        });
      const first = fire("line:1:1", "A");
      const second = fire("line:1:2", "B");
      expect(first?.receipts[0]?.action.id).toBe(Alarm.occurrenceId("poll", 1, "line:1:1"));
      expect(second?.receipts[0]?.action.id).toBe(Alarm.occurrenceId("poll", 1, "line:1:2"));
      expect(first?.receipts[0]?.action.id).not.toBe(second?.receipts[0]?.action.id);
      const revision = fixture.storage.sessions.get("monitor-session")?.revision;
      expect(fire("line:1:1", "A")).toBeUndefined();
      expect(fire("line:1:2", "B")).toBeUndefined();
      expect(fixture.storage.sessions.get("monitor-session")?.revision).toBe(revision);
      expect(fixture.rows().map((row) => row.content)).toEqual(["A", "B"]);
      expect(fixture.storage.alarms.get("poll")).toMatchObject({
        status: "armed",
        notifications: 2,
        fence: owned.fence,
      });
    } finally {
      await fixture.close();
    }
  }));

test("takeover keeps the committed dedupe digest while explicit rearm starts a fresh epoch", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      fixture.arm("poll", watch);
      const fire = (row: Alarm.Row, sourceKey: string, content: string) =>
        fixture.storage.alarms.fire({
          id: row.id,
          epoch: row.epoch,
          fence: row.fence,
          sourceKey,
          at: 1000,
          content,
          batchHash: canonicalDigest(content),
          terminal: false,
        });
      const first = fixture.storage.alarms.acquire("poll", 0);
      if (first === undefined) throw new Error("first acquire refused");
      expect(fire(first, "line:1:1", "A")?.row.status).toBe("armed");
      const taken = fixture.storage.alarms.acquire("poll", first.fence);
      if (taken === undefined) throw new Error("takeover refused");
      expect(taken).toMatchObject({
        epoch: 1,
        fence: first.fence + 1,
        lastBatch: canonicalDigest("A"),
        notifications: 1,
      });
      expect(fire(taken, "line:2:1", "A")).toBeUndefined();
      expect(fire(taken, "line:2:2", "B")?.inbox.content).toBe("B");
      expect(fire(first, "line:1:2", "C")).toBeUndefined();
      const rearmed = fixture.storage.alarms.rearm("poll", "monitor-session", 1000);
      if (rearmed === undefined) throw new Error("rearm refused");
      expect(rearmed).toMatchObject({ epoch: 2, lastBatch: null, notifications: 0 });
      expect(fire(taken, "line:2:3", "B")).toBeUndefined();
      const fresh = fixture.storage.alarms.acquire("poll", rearmed.fence);
      if (fresh === undefined) throw new Error("fresh acquire refused");
      expect(fire(fresh, "line:4:1", "A")?.inbox.content).toBe("A");
      expect(fixture.rows().map((row) => row.content)).toEqual(["A", "B", "A"]);
    } finally {
      await fixture.close();
    }
  }));

test("N+1 contenders under one fence commit N notifications plus one pause; later ones zero", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      fixture.arm("budget", watch, 2);
      const owned = fixture.storage.alarms.acquire("budget", 0);
      if (owned === undefined) throw new Error("acquire refused");
      const outcomes = ["one", "two", "three", "four"].map((content, index) =>
        fixture.storage.alarms.fire({
          id: "budget",
          epoch: owned.epoch,
          fence: owned.fence,
          sourceKey: `line:${owned.fence}:${index + 1}`,
          at: 1000,
          content,
          batchHash: canonicalDigest(content),
          terminal: false,
        }),
      );
      expect(outcomes.map((outcome) => outcome?.row.status)).toEqual([
        "armed",
        "armed",
        "paused",
        undefined,
      ]);
      const rows = fixture.rows();
      expect(rows.map((row) => row.content).slice(0, 2)).toEqual(["one", "two"]);
      expect(rows).toHaveLength(3);
      expect(JSON.parse(rows[2]?.content ?? "{}")).toMatchObject({ reason: "wake_budget" });
      expect(fixture.storage.actions.tree("monitor-session").map((action) => action.kind)).toEqual([
        "alarm.arm",
        "alarm.fired",
        "prompt",
        "alarm.fired",
        "prompt",
        "alarm.paused",
        "prompt",
      ]);
      const cancelled = fixture.storage.alarms.cancel("budget", "monitor-session", 1001);
      expect(cancelled?.status).toBe("cancelled");
      expect(
        fixture.storage.alarms.fire({
          id: "budget",
          epoch: 1,
          fence: cancelled?.fence ?? -1,
          sourceKey: "line:9:1",
          at: 1001,
          content: "after cancel",
          terminal: false,
        }),
      ).toBeUndefined();
      expect(fixture.rows()).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  }));

test("the ledger, not the evaluator, decides the deadline for a match that arrives late", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      fixture.arm("timed", { command: "true", description: "timed", timeout_ms: 50 });
      const owned = fixture.storage.alarms.acquire("timed", 0);
      if (owned === undefined) throw new Error("acquire refused");
      const fired = fixture.storage.alarms.fire({
        id: "timed",
        epoch: 1,
        fence: owned.fence,
        sourceKey: "line:1:1",
        at: 1050,
        content: "late match",
        batchHash: canonicalDigest("late match"),
        terminal: false,
      });
      expect(fired?.row).toMatchObject({ status: "fired", lastBatch: null, notifications: 0 });
      expect(JSON.parse(fired?.inbox.content ?? "{}")).toEqual({
        alarmId: "timed",
        epoch: 1,
        reason: "timeout",
        exitCode: null,
      });
    } finally {
      await fixture.close();
    }
  }));

test("a real PTY line's occurrence key is committed once; its redelivery adds nothing", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const ready = fixture.next("pty", (row) => row.content === "READY");
      fixture.arm("pty", {
        command: "printf 'READY\\n'; read value",
        description: "pty",
        persistent: true,
      });
      fixture.worker.start();
      const prompt = await ready;
      const row = fixture.storage.alarms.get("pty");
      if (row === undefined) throw new Error("missing alarm");
      const occurrence = fixture.storage.actions
        .tree("monitor-session")
        .find((action) => action.kind === "alarm.fired");
      expect(occurrence?.id).toBe(Alarm.occurrenceId("pty", row.epoch, `line:${row.fence}:1`));
      expect(occurrence?.intent.value).toMatchObject({ sourceKey: `line:${row.fence}:1` });
      expect(prompt.id).toBe(
        canonicalDigest(["alarm.inbox", "pty", row.epoch, `line:${row.fence}:1`]),
      );
      expect(
        fixture.storage.alarms.fire({
          id: "pty",
          epoch: row.epoch,
          fence: row.fence,
          sourceKey: `line:${row.fence}:1`,
          at: 1000,
          content: "READY",
          terminal: false,
        }),
      ).toBeUndefined();
      expect(fixture.rows()).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));
