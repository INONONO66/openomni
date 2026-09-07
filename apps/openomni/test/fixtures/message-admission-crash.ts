import type { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { messageFixture } from "../helpers/message-fixture";

const fixture = messageFixture();
writeSync(1, JSON.stringify({ directory: fixture.directory, dbPath: fixture.dbPath }));
// Crash after the source request/alarm and child configuration, before its inbox.
// No cleanup runs; SQLite must roll back the complete admission transaction.
const db = Reflect.get(Storage.get(), "db") as Database;
const query = db.query.bind(db);
Object.defineProperty(db, "query", {
  value: (sql: string) => {
    if (/INSERT INTO inbox\b/.test(sql) && query("SELECT id FROM alarm").all().length === 1) {
      if (query("SELECT id FROM session WHERE role = 'worker'").all().length !== 1)
        throw new Error("crash must follow child configuration");
      process.exit(86);
    }
    return query(sql);
  },
});
await fixture.send({
  to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
  type: "message",
  content: "CRASH_BOUNDARY",
  deadline: 200,
});
throw new Error("crash boundary was not reached");
