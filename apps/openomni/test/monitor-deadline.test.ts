import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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

test("path notification callback at the absolute timeout cannot outrun the scan", () =>
  Storage.withIsolation(async () => {
    const watch = spyOn(fs, "watch");
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
      const subscription:
        | readonly (fs.PathLike | fs.WatchOptions | fs.WatchListener<string>)[]
        | undefined = watch.mock.calls[0];
      if (typeof subscription?.[2] !== "function")
        throw new Error("path notification source was not installed");
      const notify = subscription[2];
      // FSEvents registers asynchronously and can drop the first write. Drive the
      // exact registered notification, retaining the real watcher, stat and ledger;
      // the separate reconciliation test covers recovery from dropped OS events.
      const ready = fixture.next("deadline");
      writeFileSync(path, "first native event");
      notify("change", "signal");
      await ready;
      const received = fixture.next("deadline");
      fixture.advance(1050);
      writeFileSync(path, "second native event at deadline");
      notify("change", "signal");
      const row = await received; // No tick: only the registered source callback runs.
      expect(row.createdAt).toBe(1050);
      expect(summary.decode(row.content)).toMatchObject({ reason: "timeout" });
      expect(fixture.storage.alarms.get("deadline")).toMatchObject({
        status: "fired",
        notifications: 1,
      });
      expect(fixture.rows()).toHaveLength(2);
    } finally {
      watch.mockRestore();
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
