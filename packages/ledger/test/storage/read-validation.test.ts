import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Communication, Message } from "@openomni/protocol";
import { Database } from "bun:sqlite";
import { PendingAskStore, PendingInteractionStore, Session, Storage } from "../../src/index";
import { Bus } from "@openomni/telemetry";

// A corrupt persisted row must fail closed on READ — parse-don't-cast, matching
// the wait/blacklist precedent. message/part
// are the same class (blind `JSON.parse(...) as T`). pending_interaction feeds
// evaluatePendingInteractionScope ({allowed:true} for WorkerComplete/ActorReply)
// and pending_ask is decision-adjacent — both fixed here (#585, same class).

function tempDbPath(): string {
  return join(tmpdir(), `read-validation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (_err) {
      void _err;
    }
  }
}

/** Overwrite a row's JSON `data` column through a second connection. */
function corruptRow(dbPath: string, table: string, id: string, data: string): void {
  const raw = new Database(dbPath);
  raw.query(`UPDATE ${table} SET data = ? WHERE id = ?`).run(data, id);
  raw.close();
}

async function seedWorkerRun(runId: string): Promise<string> {
  const session = Session.create({
    traceId: "trace-read-validation",
    title: runId,
    model: { providerID: "test", modelID: "test" },
  });
  const adapter = Storage.getAdapter().workerRunState;
  if (!adapter) throw new Error("workerRunState sub-adapter missing");
  adapter.create(session.id, {
    runId,
    agentName: "worker",
    status: "queued",
    executorKind: "internal_chat_agent",
    title: runId,
    prompt: "test",
  });
  return session.id;
}

function userMessage(sessionID: string, id: string): Message.Info {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "resident",
    model: { providerID: "test", modelID: "test" },
  };
}

function textPart(sessionID: string, messageID: string, id: string): Message.Part {
  return { id, sessionID, messageID, type: "text", text: "hello" };
}

/** Seed a bare session row (FK target) at the adapter layer. */
function seedSession(sessionID: string): void {
  Storage.getAdapter().session.set(sessionID, {
    id: sessionID,
    title: sessionID,
    model: { providerID: "test", modelID: "test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
  });
}

function pendingInteractionRecord(
  id: string,
  sessionID: string,
  runID: string,
): Communication.PendingInteraction.Record {
  return {
    id,
    workerRunId: runID,
    sessionId: sessionID,
    endpointId: "telegram:seller-1",
    channelId: "telegram:dm",
    correlation: { replyToMessageId: "reply-1" },
    allowedActions: ["report_result"],
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 9_999_999_999_999,
    followUpWindow: 100,
  };
}

function pendingAskRecord(id: string, sessionID: string): Communication.PendingAsk.Record {
  return {
    id,
    originSessionId: sessionID,
    originActorKind: "worker",
    targetKind: "resident",
    status: "open",
    correlation: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("sqlite adapters fail closed on corrupt rows", () => {
  let dbPath = "";

  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    dbPath = tempDbPath();
    Storage.initialize({ dbPath });
  });

  afterEach(() => {
    Storage.reset();
    Bus.reset();
    removeSqliteFiles(dbPath);
    dbPath = "";
  });

  test("a corrupt message row rejects on read", () => {
    const session = Session.create({
      traceId: "trace-read-validation",
      title: "s",
      model: { providerID: "test", modelID: "test" },
    });
    Session.addMessage(session.id, userMessage(session.id, "msg-corrupt"));

    corruptRow(dbPath, "message", "msg-corrupt", JSON.stringify({ role: "user" }));

    expect(() => Session.getMessages(session.id)).toThrow();
    expect(() => Storage.getAdapter().message.get(session.id, "msg-corrupt")).toThrow();
  });

  test("a corrupt part row rejects on read", () => {
    const session = Session.create({
      traceId: "trace-read-validation",
      title: "s",
      model: { providerID: "test", modelID: "test" },
    });
    Session.addMessage(session.id, userMessage(session.id, "msg-parts"));
    Session.addPart("msg-parts", textPart(session.id, "msg-parts", "part-corrupt"));

    corruptRow(dbPath, "part", "part-corrupt", JSON.stringify({ type: "text" }));

    expect(() => Session.getParts("msg-parts")).toThrow();
    expect(() => Storage.getAdapter().part.get("msg-parts", "part-corrupt")).toThrow();
  });

  test("a corrupt pending_interaction row rejects on read instead of reaching the scope verdict", async () => {
    const sessionID = await seedWorkerRun("run-pi");
    const adapter = Storage.getAdapter().pendingInteraction;
    if (!adapter) throw new Error("pendingInteraction sub-adapter missing");
    adapter.create(pendingInteractionRecord("pi-corrupt", sessionID, "run-pi"));

    // Missing id/workerRunId/session invariants. Before the fix this parses to
    // an ACTIVE allow-all-looking record that evaluatePendingInteractionScope
    // could carry to {allowed:true} for WorkerComplete/ActorReply.
    corruptRow(
      dbPath,
      "pending_interaction",
      "pi-corrupt",
      JSON.stringify({ status: "open", allowedActions: ["report_result"] }),
    );

    expect(() => PendingInteractionStore.get("pi-corrupt")).toThrow();
    expect(() => adapter.list()).toThrow();
  });

  test("a corrupt pending_ask row rejects on read", () => {
    const sessionID = "session-pa";
    seedSession(sessionID);
    const adapter = Storage.getAdapter().pendingAsk;
    if (!adapter) throw new Error("pendingAsk sub-adapter missing");
    adapter.create(pendingAskRecord("pa-corrupt", sessionID));

    corruptRow(dbPath, "pending_ask", "pa-corrupt", JSON.stringify({ status: "open" }));

    expect(() => PendingAskStore.get("pa-corrupt")).toThrow();
    expect(() => adapter.list()).toThrow();
  });
});
