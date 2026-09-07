import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import { alarmSummary } from "./helpers/alarm-payload";
import { alarmFixture } from "./helpers/alarm";

const summary = { decode: alarmSummary };

for (const mode of ["line", "exit"] as const) {
  test(`PTY ${mode} at the absolute timeout cannot outrun the scan`, () =>
    Storage.withIsolation(async () => {
      const directory = mkdtempSync(join(tmpdir(), "monitor-deadline-"));
      const fifo = join(directory, "signal");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const fixture = alarmFixture();
      let writer: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const ready = fixture.next("deadline", (row) => row.content === "READY");
        fixture.arm("deadline", {
          command: `printf 'READY\\n'; ${mode === "line" ? `cat '${fifo}'; read hold` : `read value < '${fifo}'`}`,
          description: "deadline precedence",
          timeout_ms: 50,
        });
        fixture.worker.start();
        await ready;
        const received = fixture.next("deadline");
        fixture.advance(1050);
        writer = Bun.spawn(["/bin/sh", "-c", `printf 'LATE\\n' > '${fifo}'`]);
        const row = await received; // No tick: the source itself must enforce the deadline.
        expect(row.createdAt).toBe(1050);
        expect(row.content).not.toBe("LATE");
        expect(summary.decode(row.content)).toMatchObject({
          reason: "timeout",
          alarmId: "deadline",
        });
        expect(fixture.storage.alarms.get("deadline")).toMatchObject({
          status: "fired",
          notifications: 1,
        });
        expect(fixture.rows()).toHaveLength(2);
        expect(await writer.exited).toBe(0);
      } finally {
        if (writer?.exitCode === null) writer.kill();
        if (writer !== undefined) await writer.exited;
        await fixture.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }));
}

test("native path callback at the absolute timeout cannot outrun the scan", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "monitor-path-deadline-"));
    const path = join(directory, "signal");
    writeFileSync(path, "initial");
    const fixture = alarmFixture();
    try {
      fixture.arm("deadline", {
        path,
        event: "modify",
        description: "native deadline",
        timeout_ms: 50,
      });
      fixture.worker.start();
      const ready = fixture.next("deadline");
      writeFileSync(path, "first native event");
      await ready;
      const received = fixture.next("deadline");
      fixture.advance(1050);
      writeFileSync(path, "second native event at deadline");
      const row = await received; // No tick: await the native event, not a scan.
      expect(row.createdAt).toBe(1050);
      expect(summary.decode(row.content)).toMatchObject({ reason: "timeout" });
      expect(fixture.storage.alarms.get("deadline")).toMatchObject({
        status: "fired",
        notifications: 1,
      });
      expect(fixture.rows()).toHaveLength(2);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
