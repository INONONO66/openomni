import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionHandleStore, Storage } from "../../src/index";
import { materializeSession } from "../helpers/session";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

let dbPath: string;
let raw: Database;
beforeEach(() => {
  dbPath = tempDbPath("read-validation");
  Storage.initialize({ dbPath });
  raw = new Database(dbPath);
  // Model damaged persisted bytes, bypassing write-time CHECKs on this fault connection only.
  raw.exec("PRAGMA ignore_check_constraints = ON");
  materializeSession("corrupt");
});
afterEach(() => {
  raw.close();
  Storage.reset();
  removeSqliteFiles(dbPath);
});

describe("canonical SQLite reads fail closed", () => {
  test.each([
    "{",
    "undefined",
    "",
  ])("corrupt action payload %s rejects tree and snapshot reads", (payload) => {
    raw.query("UPDATE action SET effect = ? WHERE id = ?").run(payload, "corrupt:configure");
    expect(() => SessionHandleStore.tree("corrupt")).toThrow();
    expect(() => SessionHandleStore.getSnapshot("corrupt")).toThrow();
  });

  test("invalid canonical session counters reject get and list reads", () => {
    raw.query("UPDATE session SET tools_generation = -1 WHERE id = ?").run("corrupt");
    expect(() => SessionHandleStore.row("corrupt")).toThrow();
    expect(() => SessionHandleStore.listRows()).toThrow();
  });

  test("corrupt inbox origin rejects reads without consuming the row", () => {
    SessionHandleStore.commitInbox({
      id: "pending",
      sessionId: "corrupt",
      kind: "prompt",
      content: "input",
      origin: { encodingVersion: 1, value: {} },
      createdAt: 2,
      parentActionId: null,
    });
    raw.query("UPDATE inbox SET origin = ? WHERE id = ?").run("{", "pending");
    expect(() => SessionHandleStore.pendingInbox("corrupt")).toThrow();
    expect(raw.query("SELECT status FROM inbox WHERE id = ?").get("pending")).toEqual({
      status: "pending",
    });
  });
});
