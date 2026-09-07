import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import { AlarmSourceError } from "../src/composition/alarm-sources";
import { alarmFixture } from "./helpers/alarm";
import { alarmSummary } from "./helpers/alarm-payload";

test("a path source that cannot start settles the alarm with a source_error summary", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const settled = fixture.next("missing");
      fixture.arm("missing", {
        path: join(tmpdir(), "alarm-worker-boundaries-absent", "never", "signal"),
        event: "create",
        description: "unwatchable directory",
        persistent: true,
      });
      fixture.worker.start();
      const row = await settled;
      expect(alarmSummary(row.content)).toMatchObject({
        alarmId: "missing",
        reason: "source_error",
        exitCode: null,
      });
      expect(fixture.storage.alarms.get("missing")?.status).toBe("fired");
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]).toBeInstanceOf(AlarmSourceError);
      expect(fixture.errors[0]).toMatchObject({ site: "source.start" });
      expect(fixture.wakes).toEqual(["monitor-session"]);
    } finally {
      await fixture.close();
    }
  }));

test("a watch whose timeout already elapsed before its first scan fires timeout, never a source", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const settled = fixture.next("late");
      fixture.arm("late", {
        command: "printf 'MUST_NOT_RUN\\n'; read hold",
        description: "already expired",
        timeout_ms: 50,
      });
      fixture.advance(1050);
      fixture.worker.start();
      const row = await settled;
      expect(alarmSummary(row.content)).toMatchObject({ alarmId: "late", reason: "timeout" });
      expect(fixture.rows().map((entry) => entry.content)).toEqual([row.content]);
      expect(fixture.storage.alarms.get("late")?.status).toBe("fired");
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));

test("a non-persistent watch found running at restart settles as restart instead of resuming", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "alarm-restart-"));
    const database = join(directory, "ledger.db");
    let fixture = alarmFixture(database);
    try {
      const first = fixture.next("stream");
      fixture.arm("stream", {
        command: "printf 'A\\n'; read hold",
        description: "bounded stream",
        timeout_ms: 60_000,
      });
      fixture.worker.start();
      expect((await first).content).toBe("A");
      const fence = fixture.storage.alarms.get("stream")?.fence ?? 0;
      expect(fence).toBeGreaterThan(0);
      await fixture.close();
      fixture = alarmFixture(database);
      const settled = fixture.next("stream");
      fixture.worker.start();
      expect(alarmSummary((await settled).content)).toMatchObject({
        alarmId: "stream",
        reason: "restart",
        exitCode: null,
      });
      expect(
        fixture
          .rows()
          .map((row) => row.content)
          .at(0),
      ).toBe("A");
      expect(fixture.storage.alarms.get("stream")).toMatchObject({ status: "fired" });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
