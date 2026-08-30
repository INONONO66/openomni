import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Transcript } from "@openomni/protocol";
import { Session } from "../../src/session";
import { TranscriptRecordingError, TranscriptStore } from "../../src/session/transcript";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

/**
 * #547 C3 red pins — the transcript record family:
 *
 *   1. resume-by-replay determinism: a tool-bearing turn's facts survive a
 *      storage kill/reopen and refold byte-identical to the pre-kill
 *      projection;
 *   2. projectFrom escalates a fold `rejected` outcome to a loud throw
 *      (recording defect), and the defective write persists nothing;
 *   3. fact rows are append-only: advancing a part appends a NEW fact
 *      (part.advanced) — the store exposes no update surface and stored
 *      rows never change bytes.
 */

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "transcript-store-"));
  dbPath = join(tempDir, "openomni.db");
  Storage.initialize({ dbPath });
});

afterEach(() => {
  closeStorage();
  rmSync(tempDir, { recursive: true, force: true });
});

function closeStorage(): void {
  const adapter = Storage.getInitializedDbPath() !== null ? Storage.get() : null;
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
}

/** Kill/reopen: close every connection, then boot a fresh adapter on the same file. */
function reopenStorage(): void {
  closeStorage();
  Storage.initialize({ dbPath });
}

function projectionWithParts(sessionID: string): Message.WithParts[] {
  return Session.getMessages(sessionID).map((info) => ({
    info,
    parts: Session.getParts(info.id),
  }));
}

function createSession() {
  return Session.create({
    traceId: "trace-transcript-store",
    title: "transcript",
    model: { providerID: "test", modelID: "test-model" },
  });
}

function assistantInfo(sessionID: string, messageID: string): Message.AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1_000 },
    parentID: "user-1",
    modelID: "test-model",
    providerID: "test",
    agent: "test-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function textPart(sessionID: string, messageID: string, partID: string): Message.TextPart {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text: "",
    time: { start: 1_010 },
  };
}

function toolPart(sessionID: string, messageID: string, partID: string): Message.ToolPart {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "tool",
    callID: `${partID}-call`,
    tool: "bash",
    state: { status: "pending", input: { command: "ls" } },
  };
}

/** One complete tool-bearing attempt: text part + tool part, finished stop. */
function toolTurnFacts(sessionID: string, messageID: string, attemptId: string): Transcript.Fact[] {
  return [
    { type: "message.created", attemptId, message: assistantInfo(sessionID, messageID) },
    {
      type: "part.appended",
      attemptId,
      messageId: messageID,
      part: textPart(sessionID, messageID, `${messageID}-text`),
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-text`,
      transition: { to: "completed", at: 1_020, output: "listing files" },
    },
    {
      type: "part.appended",
      attemptId,
      messageId: messageID,
      part: toolPart(sessionID, messageID, `${messageID}-tool`),
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-tool`,
      transition: { to: "running", at: 1_030 },
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-tool`,
      transition: { to: "completed", at: 1_040, output: "file-a\nfile-b", title: "bash" },
    },
    {
      type: "message.finished",
      attemptId,
      messageId: messageID,
      at: 1_050,
      finish: "stop",
      usage: { input: 12, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ];
}

describe("TranscriptStore resume-by-replay (pin 1)", () => {
  test("tool-bearing turn refolds byte-identical across a storage kill/reopen", () => {
    const session = createSession();
    for (const fact of toolTurnFacts(session.id, "msg-1", "msg-1#1")) {
      TranscriptStore.record(session.id, fact);
    }

    const preKillReplay = TranscriptStore.replay(session.id);
    const preKillProjection = projectionWithParts(session.id);
    expect(JSON.stringify(preKillReplay)).toBe(JSON.stringify(preKillProjection));

    reopenStorage();

    const replayed = TranscriptStore.replay(session.id);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(preKillReplay));
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(preKillProjection));

    const [message] = replayed;
    expect(message?.info.role).toBe("assistant");
    expect(message?.info.role === "assistant" ? message.info.finish : undefined).toBe("stop");
    const tool = message?.parts.find((part) => part.type === "tool");
    expect(tool?.type === "tool" ? tool.state.status : undefined).toBe("completed");
  });

  test("retry attempts: replay projects the latest attempt only, matching the projection", () => {
    const session = createSession();
    const messageID = "msg-retry";

    // Attempt 1 fails mid-turn: text part never completes, attempt closes error.
    TranscriptStore.record(session.id, {
      type: "message.created",
      attemptId: `${messageID}#1`,
      message: assistantInfo(session.id, messageID),
    });
    TranscriptStore.record(session.id, {
      type: "part.appended",
      attemptId: `${messageID}#1`,
      messageId: messageID,
      part: textPart(session.id, messageID, `${messageID}-attempt1-text`),
    });
    TranscriptStore.record(session.id, {
      type: "message.finished",
      attemptId: `${messageID}#1`,
      messageId: messageID,
      at: 1_015,
      finish: "error",
      usage: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    // Attempt 2 folds from scratch under a new attemptId and succeeds.
    for (const fact of toolTurnFacts(session.id, messageID, `${messageID}#2`)) {
      TranscriptStore.record(session.id, fact);
    }

    reopenStorage();

    const replayed = TranscriptStore.replay(session.id);
    expect(replayed).toHaveLength(1);
    const [message] = replayed;
    expect(message?.parts.map((part) => part.id)).toEqual([
      `${messageID}-text`,
      `${messageID}-tool`,
    ]);

    const projection = projectionWithParts(session.id);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(projection));
  });

  test("replay recovers the turn from the fact stream alone", () => {
    const session = createSession();
    for (const fact of toolTurnFacts(session.id, "msg-1", "msg-1#1")) {
      TranscriptStore.record(session.id, fact);
    }

    reopenStorage();

    // Drop the read-model projection rows: replay must recover from the
    // fact stream itself (the record), not from the projection tables.
    const adapter = Storage.get();
    for (const part of adapter.part.list("msg-1")) {
      adapter.part.remove("msg-1", part.id);
    }
    adapter.message.remove(session.id, "msg-1");

    const replayed = TranscriptStore.replay(session.id);
    expect(replayed).toHaveLength(1);
    const [message] = replayed;
    expect(message?.info.role).toBe("assistant");
    const text = message?.parts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(text).toBe("listing files");
  });
});

describe("TranscriptStore record-path fold cache (#562 F7)", () => {
  test("kill/reopen mid-attempt: recording continues and replay matches the projection", () => {
    const session = createSession();
    const facts = toolTurnFacts(session.id, "msg-cache", "msg-cache#1");

    for (const fact of facts.slice(0, 3)) TranscriptStore.record(session.id, fact);
    reopenStorage();
    for (const fact of facts.slice(3)) TranscriptStore.record(session.id, fact);

    const replayed = TranscriptStore.replay(session.id);
    const projection = projectionWithParts(session.id);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(projection));
    const [message] = replayed;
    expect(message?.info.role === "assistant" ? message.info.finish : undefined).toBe("stop");
  });

  test("outer-transaction rollback: count continuity refolds instead of trusting the cache", () => {
    const session = createSession();
    const facts = toolTurnFacts(session.id, "msg-rollback", "msg-rollback#1");
    const [created, appended, ...rest] = facts;
    if (!created || !appended) throw new Error("fixture shape");
    TranscriptStore.record(session.id, created);

    // The savepoint commits inside record(), the cache advances, then the
    // OUTER transaction rolls everything back — cache and disk now disagree.
    const adapter = Storage.get();
    expect(() =>
      adapter.transaction(() => {
        TranscriptStore.record(session.id, appended);
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(Storage.get().transcriptFact?.list(session.id)).toHaveLength(1);

    // Re-recording the same fact must refold from the stored stream (count
    // mismatch), not double-apply the cached state.
    for (const fact of [appended, ...rest]) TranscriptStore.record(session.id, fact);

    const replayed = TranscriptStore.replay(session.id);
    const projection = projectionWithParts(session.id);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(projection));
    expect(replayed[0]?.parts.map((part) => part.id)).toEqual([
      "msg-rollback-text",
      "msg-rollback-tool",
    ]);
  });

  test("cached-path fold rejection stays loud and persists nothing", () => {
    const session = createSession();
    TranscriptStore.record(session.id, {
      type: "message.created",
      attemptId: "msg-dup#1",
      message: assistantInfo(session.id, "msg-dup"),
    });

    // Second message.created on the same (now cached) attempt: the O(1)
    // cached fold must escalate exactly like the refold path.
    expect(() =>
      TranscriptStore.record(session.id, {
        type: "message.created",
        attemptId: "msg-dup#1",
        message: assistantInfo(session.id, "msg-dup"),
      }),
    ).toThrow(TranscriptRecordingError);
    expect(Storage.get().transcriptFact?.list(session.id)).toHaveLength(1);
  });
});

describe("TranscriptStore recording defects (pin 2)", () => {
  test("out-of-order fact write escalates to a loud throw and persists nothing", () => {
    const session = createSession();

    // part.advanced with no message.created for its attempt: unknown_message.
    expect(() =>
      TranscriptStore.record(session.id, {
        type: "part.advanced",
        attemptId: "msg-x#1",
        messageId: "msg-x",
        partId: "msg-x-text",
        transition: { to: "completed", at: 1_020, output: "orphan" },
      }),
    ).toThrow(TranscriptRecordingError);

    expect(TranscriptStore.replay(session.id)).toEqual([]);
    expect(Storage.get().transcriptFact?.list(session.id)).toEqual([]);
  });

  test("illegal transition (skipping running) throws with the fold's reject reason", () => {
    const session = createSession();
    TranscriptStore.record(session.id, {
      type: "message.created",
      attemptId: "msg-1#1",
      message: assistantInfo(session.id, "msg-1"),
    });
    TranscriptStore.record(session.id, {
      type: "part.appended",
      attemptId: "msg-1#1",
      messageId: "msg-1",
      part: toolPart(session.id, "msg-1", "msg-1-tool"),
    });

    const factCountBefore = Storage.get().transcriptFact?.list(session.id).length;

    let thrown: unknown;
    try {
      TranscriptStore.record(session.id, {
        type: "part.advanced",
        attemptId: "msg-1#1",
        messageId: "msg-1",
        partId: "msg-1-tool",
        transition: { to: "completed", at: 1_040, output: "skipped running" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TranscriptRecordingError);
    expect((thrown as TranscriptRecordingError).reason).toBe("invalid_transition");
    expect(Storage.get().transcriptFact?.list(session.id).length).toBe(factCountBefore);
  });

  test("projectFrom escalates a rejected outcome on a raw fact stream", () => {
    const facts: Transcript.Fact[] = [
      {
        type: "part.appended",
        attemptId: "msg-1#1",
        messageId: "msg-1",
        part: textPart("session-1", "msg-1", "msg-1-text"),
      },
    ];
    expect(() => TranscriptStore.projectFrom(facts)).toThrow(TranscriptRecordingError);
  });
});

describe("TranscriptStore append-only fact rows (pin 3)", () => {
  test("advancing a part appends a new fact and never rewrites stored rows", () => {
    const session = createSession();
    TranscriptStore.record(session.id, {
      type: "message.created",
      attemptId: "msg-1#1",
      message: assistantInfo(session.id, "msg-1"),
    });
    TranscriptStore.record(session.id, {
      type: "part.appended",
      attemptId: "msg-1#1",
      messageId: "msg-1",
      part: toolPart(session.id, "msg-1", "msg-1-tool"),
    });

    const facts = Storage.get().transcriptFact;
    const before = facts?.list(session.id) ?? [];

    TranscriptStore.record(session.id, {
      type: "part.advanced",
      attemptId: "msg-1#1",
      messageId: "msg-1",
      partId: "msg-1-tool",
      transition: { to: "running", at: 1_030 },
    });

    const after = facts?.list(session.id) ?? [];
    expect(after.length).toBe(before.length + 1);
    // Previously stored rows are byte-identical: recording advances state
    // via a NEW fact, never an UPDATE of an existing row.
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after.at(-1)?.data).toContain('"part.advanced"');
  });

  test("the fact sub-adapter exposes no update or delete surface", () => {
    const facts = Storage.get().transcriptFact;
    expect(facts).toBeDefined();
    // countByAttempt (#562 F7) is read-only — still no update/delete surface.
    expect(Object.keys(facts ?? {}).sort()).toEqual([
      "append",
      "countByAttempt",
      "list",
      "listByAttempt",
    ]);
  });
});
