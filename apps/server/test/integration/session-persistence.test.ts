import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Session, SqliteStorageAdapter, Storage } from "@openomni/ledger";

let tmpDir = "";
let dbPath = "";
let adapter: SqliteStorageAdapter | null = null;

function makeUserMessage(sessionID: string, id: string): Message.Info {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "server-test",
    model: { providerID: "test", modelID: "test-model" },
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "server-persistence-"));
  dbPath = join(tmpDir, "test.db");
  adapter = new SqliteStorageAdapter(dbPath);
  Storage.initialize({ dbPath: ":memory:" });
  Storage.configure(adapter);
});

afterEach(async () => {
  adapter?.close();
  adapter = null;
  Storage.reset();
  await rm(tmpDir, { recursive: true, force: true });
});

test("session persists across storage re-init", () => {
  const session = Session.create({
    traceId: "trace-session-persistence",
    title: "persist-session",
    model: { providerID: "test", modelID: "test-model" },
  });

  adapter?.close();
  adapter = new SqliteStorageAdapter(dbPath);
  Storage.configure(adapter);

  const loaded = Session.get(session.id);
  expect(loaded).toBeDefined();
  expect(loaded?.id).toBe(session.id);
});

test("message persists with status across storage re-init", () => {
  const session = Session.create({
    traceId: "trace-session-persistence",
    title: "persist-message",
    model: { providerID: "test", modelID: "test-model" },
  });

  Session.addMessage(session.id, makeUserMessage(session.id, "msg-1"), { status: "received" });

  adapter?.close();
  adapter = new SqliteStorageAdapter(dbPath);
  Storage.configure(adapter);

  const messages = Session.getMessages(session.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.id).toBe("msg-1");

  const received = Storage.get().message.findByStatus?.("received") ?? [];
  expect(received.some((m) => m.id === "msg-1")).toBe(true);
});
