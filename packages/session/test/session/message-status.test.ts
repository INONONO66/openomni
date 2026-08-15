import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session/index";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import "../../src/storage/initialize";

function makeUserMessage(sessionID: string, messageID: string): Message.Info {
  return {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

describe("message status tracking", () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;
  let rawDb: Database;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `test-msg-status-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(adapter);
    rawDb = new Database(dbPath, { readonly: true });
  });

  afterEach(() => {
    rawDb.close();
    adapter.close();
    try {
      unlinkSync(dbPath);
    } catch {
      /* expected */
    }
    Storage.reset();
  });

  function queryStatus(messageID: string): string | null {
    const row = rawDb.query("SELECT status FROM message WHERE id = ?").get(messageID) as {
      status: string;
    } | null;
    return row?.status ?? null;
  }

  test("addMessage without status defaults to 'completed'", () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "test", modelID: "test-model" },
    });

    const msg = makeUserMessage(session.id, "msg-1");
    Session.addMessage(session.id, msg);

    expect(queryStatus("msg-1")).toBe("completed");
  });

  test("addMessage with status 'received'", () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "test", modelID: "test-model" },
    });

    const msg = makeUserMessage(session.id, "msg-2");
    Session.addMessage(session.id, msg, { status: "received" });

    expect(queryStatus("msg-2")).toBe("received");
  });

  test("updateMessageStatus transitions through lifecycle", () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "test", modelID: "test-model" },
    });

    const msg = makeUserMessage(session.id, "msg-3");
    Session.addMessage(session.id, msg, { status: "received" });
    expect(queryStatus("msg-3")).toBe("received");

    Session.updateMessageStatus("msg-3", "processing");
    expect(queryStatus("msg-3")).toBe("processing");

    Session.updateMessageStatus("msg-3", "completed");
    expect(queryStatus("msg-3")).toBe("completed");
  });

  test("updateMessageStatus does not throw with in-memory SQLite", () => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });

    const session = Session.create({
      title: "test",
      model: { providerID: "test", modelID: "test-model" },
    });

    const msg = makeUserMessage(session.id, "msg-4");
    Session.addMessage(session.id, msg, { status: "received" });

    expect(() => Session.updateMessageStatus("msg-4", "processing")).not.toThrow();
    expect(() => Session.updateMessageStatus("msg-4", "completed")).not.toThrow();
  });

  test("setStatus on adapter level", () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "test", modelID: "test-model" },
    });

    const msg = makeUserMessage(session.id, "msg-5");
    adapter.message.set(session.id, msg);

    expect(queryStatus("msg-5")).toBe("completed");

    if (adapter.message.setStatus === undefined) throw new Error("shape");
    adapter.message.setStatus("msg-5", "processing");
    expect(queryStatus("msg-5")).toBe("processing");
  });
});
