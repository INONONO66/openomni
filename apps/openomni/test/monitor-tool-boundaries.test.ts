import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import { alarmFixture } from "./helpers/alarm";

test("monitor command: real PTY match, dedupe and exit summary", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      const match = fixture.next("pty", (row) => row.content === "MATCH exact  ");
      const summary = fixture.next("pty", (row) => row.content.startsWith("{"));
      fixture.arm("pty", {
        command: "test -t 1 || exit 42; printf 'ignore\\nMATCH exact  \\nMATCH exact  \\n'",
        filter: "^MATCH",
        description: "PTY",
        persistent: true,
      });
      fixture.worker.start();
      expect((await match).content).toBe("MATCH exact  ");
      expect(JSON.parse((await summary).content)).toEqual({
        alarmId: "pty",
        epoch: 1,
        reason: "exit",
        exitCode: 0,
      });
      expect(fixture.rows().map((row) => row.origin.value)).toEqual(["pty", "pty"]);
      expect(fixture.storage.alarms.get("pty")?.status).toBe("fired");
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));

test("monitor path: subscribed create and modify, then cancellation fences callbacks", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "monitor-path-"));
    const path = join(directory, "target");
    const fixture = alarmFixture();
    try {
      fixture.arm("create", { path, event: "create", description: "create", persistent: true });
      fixture.worker.start();
      const created = fixture.next("create");
      writeFileSync(path, "first");
      // No yield: the native callback cannot run before this reconciliation.
      fixture.worker.tick();
      // Assert durable truth before native callbacks or bus microtasks can run.
      expect(fixture.rows()).toHaveLength(1);
      expect(fixture.storage.actions.tree("monitor-session").map((action) => action.kind)).toEqual(["alarm.arm", "alarm.fired", "prompt"]);
      const createdRow = await created;
      expect(JSON.parse(createdRow.content)).toEqual({ path, event: "create" });
      const createActions = fixture.storage.actions.tree("monitor-session");
      expect(createActions.map((action) => action.kind)).toEqual([
        "alarm.arm",
        "alarm.fired",
        "prompt",
      ]);
      expect(createActions.at(-1)?.id).toBe(createdRow.id);
      const revision = fixture.storage.sessions.get("monitor-session")?.revision;
      fixture.worker.tick();
      expect(fixture.storage.sessions.get("monitor-session")?.revision).toBe(revision);
      fixture.arm("modify", { path, event: "modify", description: "modify", persistent: true });
      fixture.worker.tick(); // Synchronous source installation precedes the filesystem mutation.
      const modified = fixture.next("modify");
      writeFileSync(path, "second longer");
      fixture.worker.tick();
      expect(fixture.rows()).toHaveLength(2);
      expect(fixture.rows().at(-1)?.origin.value).toBe("modify");
      expect(fixture.storage.actions.tree("monitor-session").at(-1)?.kind).toBe("prompt");
      expect(JSON.parse((await modified).content)).toEqual({ path, event: "modify" });
      const old = fixture.storage.alarms.get("modify");
      if (old === undefined) throw new Error("missing alarm");
      fixture.storage.alarms.cancel("modify", 1001);
      writeFileSync(path, "after cancel");
      fixture.worker.tick();
      expect(
        fixture.storage.alarms.fire({
          id: old.id,
          epoch: old.epoch,
          fence: old.fence,
          actionId: "stale",
          inboxId: "stale-inbox",
          at: 1001,
          content: "late callback",
          terminal: false,
          limit: 8,
        }),
      ).toBeUndefined();
      expect(fixture.rows()).toHaveLength(2);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
