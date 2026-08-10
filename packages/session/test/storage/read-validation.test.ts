import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import { Database } from "bun:sqlite";
import { Bus, Session, Storage, WorkerGrantStore } from "../../src/index";

// A corrupt persisted row must fail closed on READ — parse-don't-cast, matching
// the wait/blacklist precedent. worker_grant is authz-critical: an unvalidated
// row was previously handed straight to WorkerGrantStore.evaluate. message/part
// are the same class (blind `JSON.parse(...) as T`).

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
  const session = Session.create({ title: runId, model: { providerID: "test", modelID: "test" } });
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

  test("a corrupt worker_grant row rejects on read instead of reaching evaluate()", async () => {
    await seedWorkerRun("run-corrupt");
    WorkerGrantStore.create({
      id: "grant-corrupt",
      workerRunId: "run-corrupt",
      allowedActions: ["worker.send"],
    });

    // Structurally-valid-looking but schema-invalid: missing id/workerRunId/
    // version/timestamps. Before the fix this row parses to an object that
    // evaluateRecord happily treats as an ACTIVE allow-all grant.
    corruptRow(
      dbPath,
      "worker_grant",
      "grant-corrupt",
      JSON.stringify({ status: "active", allowedActions: ["worker.send"] }),
    );

    expect(() => WorkerGrantStore.get("grant-corrupt")).toThrow();
    expect(() =>
      WorkerGrantStore.evaluate({ workerRunId: "run-corrupt", action: "worker.send" }),
    ).toThrow();
  });

  test("a corrupt message row rejects on read", () => {
    const session = Session.create({
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
      title: "s",
      model: { providerID: "test", modelID: "test" },
    });
    Session.addMessage(session.id, userMessage(session.id, "msg-parts"));
    Session.addPart("msg-parts", textPart(session.id, "msg-parts", "part-corrupt"));

    corruptRow(dbPath, "part", "part-corrupt", JSON.stringify({ type: "text" }));

    expect(() => Session.getParts("msg-parts")).toThrow();
    expect(() => Storage.getAdapter().part.get("msg-parts", "part-corrupt")).toThrow();
  });
});
