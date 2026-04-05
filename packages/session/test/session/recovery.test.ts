import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionEvent } from "@openomni/protocol";
import { Session } from "../../src/session";
import { EventLog } from "../../src/event-log/index";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-session-recovery-test-"));
  Storage.configure(new SqliteStorageAdapter(join(tmpDir, "test.db")));
});

afterEach(() => {
  Storage.reset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Session recovery lifecycle", () => {
  test("suspend appends session_suspended event with next sequence", async () => {
    const session = Session.create({
      title: "Recovery",
      model: { providerID: "test", modelID: "test-model" },
    });

    await EventLog.append(session.id, {
      type: "llm_response",
      turnIndex: 0,
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      timestamp: new Date().toISOString(),
      sequence: 1,
    });

    const suspended = await Session.suspend(session.id);
    expect(suspended).toBe(true);

    const events: ExecutionEvent.T[] = [];
    for await (const event of EventLog.replay(session.id)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("session_suspended");
    expect(events[1].sequence).toBe(2);
  });

  test("resume reconstructs assistant message history from llm_response events", async () => {
    const session = Session.create({
      title: "Recovery",
      model: { providerID: "test", modelID: "test-model" },
    });

    await EventLog.append(session.id, {
      type: "llm_response",
      turnIndex: 0,
      text: "first",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      timestamp: new Date().toISOString(),
      sequence: 1,
    });
    await EventLog.append(session.id, {
      type: "step_failed",
      stepId: "s1",
      error: "ignored",
      timestamp: new Date().toISOString(),
      sequence: 2,
    });
    await EventLog.append(session.id, {
      type: "llm_response",
      turnIndex: 1,
      text: "second",
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      timestamp: new Date().toISOString(),
      sequence: 3,
    });

    const recovered = await Session.resume(session.id);
    expect(recovered).toHaveLength(2);
    expect(recovered[0].text).toBe("first");
    expect(recovered[1].text).toBe("second");
  });

  test("abandon removes session and clears session event log", async () => {
    const session = Session.create({
      title: "Recovery",
      model: { providerID: "test", modelID: "test-model" },
    });

    await EventLog.append(session.id, {
      type: "llm_response",
      turnIndex: 0,
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      timestamp: new Date().toISOString(),
      sequence: 1,
    });

    const abandoned = await Session.abandon(session.id);
    expect(abandoned).toBe(true);
    expect(Session.get(session.id)).toBeUndefined();

    const replayed: ExecutionEvent.T[] = [];
    for await (const event of EventLog.replay(session.id)) {
      replayed.push(event);
    }
    expect(replayed).toHaveLength(0);
  });
});
