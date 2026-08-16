import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import { recoverInterruptedMessages } from "../../src/recovery";

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
  tmpDir = await mkdtemp(join(tmpdir(), "server-recovery-"));
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

test("marks processing message as received when no assistant response", async () => {
  const session = Session.create({
    traceId: "trace-test",
    title: "recovery",
    model: { providerID: "test", modelID: "test-model" },
  });

  Session.addMessage(session.id, makeUserMessage(session.id, "user-msg-1"), {
    status: "processing",
  });

  await recoverInterruptedMessages("trace-test");

  const received = Storage.get().message.findByStatus?.("received") ?? [];
  expect(received.some((m) => m.id === "user-msg-1")).toBe(true);
});

test("recovery does not throw on empty storage", async () => {
  await recoverInterruptedMessages("trace-test");
  expect(true).toBe(true);
});
