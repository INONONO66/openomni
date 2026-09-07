import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import { alarmFixture } from "./helpers/alarm";

test("alarm restart: SQLite reopen fires at the exact boundary with atomic prompt truth", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "alarm-reopen-"));
    const database = join(directory, "ledger.db");
    let fixture = alarmFixture(database);
    try {
      fixture.storage.alarms.arm({
        id: "at",
        sessionId: "monitor-session",
        kind: "at",
        fireAt: 2000,
        spec: { encodingVersion: 1, value: "deadline" },
      });
      await fixture.close();
      fixture = alarmFixture(database);
      fixture.advance(1999);
      fixture.worker.start();
      expect(fixture.rows()).toEqual([]);
      const fired = fixture.next("at");
      fixture.advance(2000);
      fixture.worker.tick();
      const prompt = await fired;
      expect(prompt).toMatchObject({
        origin: { value: "at" },
        content: "deadline",
        createdAt: 2000,
      });
      const tree = fixture.storage.actions.tree("monitor-session");
      expect(tree.map((action) => action.kind)).toEqual(["alarm.arm", "alarm.fired", "prompt"]);
      expect(tree.at(-1)?.ordinal).toBe(fixture.storage.sessions.get("monitor-session")?.revision);
      expect(tree.at(-1)?.id).toBe(prompt.id);
      fixture.worker.tick();
      expect(fixture.rows()).toHaveLength(1);
      expect(fixture.wakes).toEqual(["monitor-session"]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("persistent polling takeover preserves dedupe and does not replay a restart gap", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "watch-reopen-"));
    const database = join(directory, "ledger.db");
    const data = join(directory, "poll-result");
    writeFileSync(data, "");
    let fixture = alarmFixture(database);
    try {
      const first = fixture.next("stream");
      fixture.arm("stream", {
        command: `printf 'A\\n'; cat '${data}'; read value`,
        description: "idempotent poll",
        persistent: true,
      });
      fixture.worker.start();
      expect((await first).content).toBe("A");
      const fence = fixture.storage.alarms.get("stream")?.fence;
      await fixture.close();
      writeFileSync(data, "GAP\n");
      writeFileSync(data, "B\n");
      fixture = alarmFixture(database);
      const second = fixture.next("stream");
      fixture.worker.start();
      expect((await second).content).toBe("B");
      expect(fixture.rows().map((row) => row.content)).toEqual(["A", "B"]);
      expect(fixture.storage.alarms.get("stream")).toMatchObject({
        status: "armed",
        epoch: 1,
        notifications: 2,
      });
      expect(fixture.storage.alarms.get("stream")?.fence).toBeGreaterThan(fence ?? 0);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
