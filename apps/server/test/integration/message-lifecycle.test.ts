import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Session, SqliteStorageAdapter, Storage } from "@openomni/session";

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
  tmpDir = await mkdtemp(join(tmpdir(), "server-lifecycle-"));
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

test("message status transitions received -> processing -> completed", () => {
  const session = Session.create({
    title: "lifecycle",
    model: { providerID: "test", modelID: "test-model" },
  });

  Session.addMessage(session.id, makeUserMessage(session.id, "msg-1"), { status: "received" });
  Session.updateMessageStatus("msg-1", "processing");
  Session.updateMessageStatus("msg-1", "completed");

  const completed = Storage.get().message.findByStatus?.("completed") ?? [];
  expect(completed.some((m) => m.id === "msg-1")).toBe(true);

  const processing = Storage.get().message.findByStatus?.("processing") ?? [];
  expect(processing.some((m) => m.id === "msg-1")).toBe(false);
});

test("message defaults to completed when status is omitted", () => {
  const session = Session.create({
    title: "lifecycle-default",
    model: { providerID: "test", modelID: "test-model" },
  });

  Session.addMessage(session.id, makeUserMessage(session.id, "msg-default"));

  const completed = Storage.get().message.findByStatus?.("completed") ?? [];
  expect(completed.some((m) => m.id === "msg-default")).toBe(true);
});
