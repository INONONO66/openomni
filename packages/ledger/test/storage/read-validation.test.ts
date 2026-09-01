import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Database } from "bun:sqlite";
import { Session, Storage } from "../../src/index";
import { Bus } from "@openomni/telemetry";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

// A corrupt persisted row must fail closed on READ — parse-don't-cast, matching
// the wait/blacklist precedent. message/part are the same class (blind
// `JSON.parse(...) as T`), fixed in #584/#585.

/** Overwrite a row's JSON `data` column through a second connection. */
function corruptRow(dbPath: string, table: string, id: string, data: string): void {
  const raw = new Database(dbPath);
  raw.query(`UPDATE ${table} SET data = ? WHERE id = ?`).run(data, id);
  raw.close();
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
    dbPath = tempDbPath("read-validation");
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
    expect(() => Storage.get().message.get(session.id, "msg-corrupt")).toThrow();
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
    expect(() => Storage.get().part.get("msg-parts", "part-corrupt")).toThrow();
  });
});
