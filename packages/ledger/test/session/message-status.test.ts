import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session/index";
import "../../src/storage/initialize";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";

const message = (sessionID: string, id: string): Message.Info => ({
  id, sessionID, role: "user", time: { created: Date.now() }, agent: "test-agent",
  model: { providerID: "test", modelID: "test-model" },
});

describe("message status tracking", () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;
  let rawDb: Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-msg-status-${crypto.randomUUID()}.db`);
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(adapter);
    rawDb = new Database(dbPath, { readonly: true });
  });
  afterEach(() => {
    rawDb.close();
    adapter.close();
    try { unlinkSync(dbPath); } catch { /* expected */ }
    Storage.reset();
  });

  const status = (id: string): string | null => {
    const row = rawDb.query("SELECT status FROM message WHERE id = ?").get(id) as { status: string } | null;
    return row?.status ?? null;
  };
  const createSession = () => Session.create({
    traceId: "trace-message-status", title: "test",
    model: { providerID: "test", modelID: "test-model" },
  });

  for (const [name, supplied, expected] of [
    ["defaults to completed", undefined, "completed"],
    ["accepts explicit received", "received", "received"],
  ] as const) {
    test(`addMessage ${name}`, () => {
      const session = createSession();
      Session.addMessage(session.id, message(session.id, name), supplied === undefined ? undefined : { status: supplied });
      expect(status(name)).toBe(expected);
    });
  }

  test("updateMessageStatus transitions through the lifecycle", () => {
    const session = createSession();
    Session.addMessage(session.id, message(session.id, "msg-lifecycle"), { status: "received" });
    expect(status("msg-lifecycle")).toBe("received");
    for (const next of ["processing", "completed"] as const) {
      Session.updateMessageStatus("msg-lifecycle", next);
      expect(status("msg-lifecycle")).toBe(next);
    }
  });
});
