import type { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { messageFixture } from "../helpers/message-fixture";

const fixture = messageFixture();
writeSync(1, JSON.stringify({ directory: fixture.directory, dbPath: fixture.dbPath }));
// Inject loss at the actual SQL boundary after child/inbox writes and before
// alarm insertion. No cleanup runs: reopening must recover SQLite's transaction.
const db = Reflect.get(Storage.get(), "db") as Database;
const query = db.query.bind(db);
Object.defineProperty(db, "query", {
  value: (sql: string) => {
    if (/INSERT INTO alarm\b/.test(sql)) {
      if (query("SELECT id FROM inbox").all().length !== 1)
        throw new Error("crash must follow inbox insertion");
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
