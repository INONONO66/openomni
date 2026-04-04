import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEvent } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { EventLog } from "../../src/event-log/index";

const now = new Date().toISOString();

function makeEvent(type: string, sequence: number) {
  if (type === "llm_response") {
    return {
      type: "llm_response" as const,
      turnIndex: 0,
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      timestamp: now,
      sequence,
    };
  }
  return {
    type: "session_suspended" as const,
    reason: "test",
    timestamp: now,
    sequence,
  };
}

function ensureSession(adapter: SqliteStorageAdapter, id: string): void {
  adapter.session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now(), updated: Date.now() },
  });
}

describe("EventLog with SQLite adapter", () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `test-eventlog-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);
    EventLog._reset();
  });

  afterEach(() => {
    EventLog._reset();
    Storage.reset();
    try {
      adapter.close();
    } catch {}
    unlinkSync(dbPath);
  });

  test("append and replay persists across adapter recreation", async () => {
    ensureSession(adapter, "sess-1");
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.append("sess-1", makeEvent("session_suspended", 2));
    await EventLog.append("sess-1", makeEvent("llm_response", 3));
    await EventLog.append("sess-1", makeEvent("llm_response", 4));
    await EventLog.append("sess-1", makeEvent("session_suspended", 5));
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter2);

    const events: ExecutionEvent.T[] = [];
    for await (const event of EventLog.replay("sess-1")) {
      events.push(event);
    }

    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(1);
    expect(events[4].sequence).toBe(5);

    adapter2.close();
  });

  test("listIncomplete returns sessions with pending events", async () => {
    ensureSession(adapter, "sess-1");
    ensureSession(adapter, "sess-2");
    ensureSession(adapter, "sess-3");
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.append("sess-2", makeEvent("llm_response", 1));
    await EventLog.append("sess-3", makeEvent("llm_response", 1));
    await EventLog.markComplete("sess-2");

    const incomplete = await EventLog.listIncomplete();
    expect(incomplete).toContain("sess-1");
    expect(incomplete).toContain("sess-3");
    expect(incomplete).not.toContain("sess-2");
  });

  test("markComplete marks all events in session", async () => {
    ensureSession(adapter, "sess-1");
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.append("sess-1", makeEvent("session_suspended", 2));
    await EventLog.markComplete("sess-1");

    const incomplete = await EventLog.listIncomplete();
    expect(incomplete).not.toContain("sess-1");
  });

  test("replay returns empty for unknown session", async () => {
    const events: ExecutionEvent.T[] = [];
    for await (const event of EventLog.replay("unknown")) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  test("multiple sessions are independent", async () => {
    ensureSession(adapter, "sess-a");
    ensureSession(adapter, "sess-b");
    await EventLog.append("sess-a", makeEvent("llm_response", 1));
    await EventLog.append("sess-b", makeEvent("session_suspended", 1));

    const eventsA: ExecutionEvent.T[] = [];
    for await (const e of EventLog.replay("sess-a")) eventsA.push(e);
    const eventsB: ExecutionEvent.T[] = [];
    for await (const e of EventLog.replay("sess-b")) eventsB.push(e);

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].type).toBe("llm_response");
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].type).toBe("session_suspended");
  });
});
