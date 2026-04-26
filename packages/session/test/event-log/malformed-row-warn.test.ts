import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ExecutionEvent } from "@openomni/protocol";
import { Log } from "../../src/log/index";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import "../../src/storage/initialize";
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

describe("EventLog.replay warns on malformed rows", () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `test-eventlog-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(adapter);
    EventLog._reset();
  });

  afterEach(() => {
    EventLog._reset();
    Storage.reset();
    try {
      adapter.close();
    } catch {
      /* already closed */
    }
    unlinkSync(dbPath);
  });

  test("replay calls Log.warn when encountering malformed event row", async () => {
    ensureSession(adapter, "sess-1");
    await EventLog.append("sess-1", makeEvent("llm_response", 1));

    const rawDb = new Database(dbPath);
    rawDb
      .query("INSERT INTO event_log (session_id, type, data, time_created) VALUES (?, ?, ?, ?)")
      .run("sess-1", "llm_response", "{ invalid json", Date.now());
    rawDb.close();

    await EventLog.append("sess-1", makeEvent("session_suspended", 3));

    const warnSpy = spyOn(Log, "warn");

    const events: ExecutionEvent[] = [];
    for await (const event of EventLog.replay("sess-1")) {
      events.push(event);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);

    const callArgs = warnSpy.mock.calls[0];
    expect(callArgs[0]).toBe("EventLog.replay: malformed event row skipped");
    expect(callArgs[1]).toHaveProperty("sessionId", "sess-1");
    expect(callArgs[1]).toHaveProperty("error");

    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(3);
  });

  test("replay skips multiple malformed rows and warns for each", async () => {
    ensureSession(adapter, "sess-3");
    await EventLog.append("sess-3", makeEvent("llm_response", 1));

    const rawDb = new Database(dbPath);
    rawDb
      .query("INSERT INTO event_log (session_id, type, data, time_created) VALUES (?, ?, ?, ?)")
      .run("sess-3", "llm_response", "{ bad json 1", Date.now());
    rawDb
      .query("INSERT INTO event_log (session_id, type, data, time_created) VALUES (?, ?, ?, ?)")
      .run("sess-3", "llm_response", "{ bad json 2", Date.now());
    rawDb.close();

    await EventLog.append("sess-3", makeEvent("session_suspended", 4));

    const warnSpy = spyOn(Log, "warn");
    const initialCallCount = warnSpy.mock.calls.length;

    const events: ExecutionEvent[] = [];
    for await (const event of EventLog.replay("sess-3")) {
      events.push(event);
    }

    const newCallCount = warnSpy.mock.calls.length - initialCallCount;
    expect(newCallCount).toBe(2);

    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(4);
  });
});
