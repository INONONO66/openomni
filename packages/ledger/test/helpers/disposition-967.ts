import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Migration } from "../../src/storage/migration-runner";
import { createSqliteWaitAdapter } from "../../src/storage/sqlite-wait-adapter";
import { Wait } from "@openomni/protocol";
import { Ledger } from "../../src/ledger-core/index";

/** Historical fixture uses the shipped runner, never the auto-migrating adapter. */
export function createDispositionFixture(reportCleanup = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openomni-967-")));
  const path = join(directory, "source.sqlite");
  const db = new Database(path, { create: true, safeIntegers: true });
  const migrationDir = resolve(import.meta.dir, "../../migration");
  Migration.applyOrdered(db, migrationDir, readdirSync(migrationDir)
    .filter((name) => /^00[0-3][0-9]_/.test(name) && name < "0034")
    .sort()
    .map((name) => ({ name: `${name}/migration.sql` })));
  db.run("INSERT INTO bus_event (event_type, category, data, trace_id, time_created) VALUES ('historical', 'retired', '{}', 'trace', 1)");
  db.run("INSERT INTO session (id, data, time_created, time_updated) VALUES ('legacy', '{}', 1, 1)");
  db.run("INSERT INTO message (id, session_id, data, role, time_created, status) VALUES ('message', 'legacy', '{\"pending\":true}', NULL, 9223372036854775807, 'pending')");
  db.run("INSERT INTO part (id, message_id, data, type, time_start) VALUES ('part', 'message', X'00FF80', NULL, -9223372036854775808)");
  db.run("INSERT INTO action (id, session_id, kind, intent, effect, irreversible, encoding_version, ts, ordinal) VALUES ('attempt-history', 'legacy', 'attempt', '{}', '{}', 1, 1, 1, 1)");
  db.run("INSERT INTO inbox (id, session_id, kind, content, origin, encoding_version, status, time_created, ordinal) VALUES ('pending-inbox', 'legacy', 'prompt', 'pending', '{}', 1, 'pending', 1, 1)");
  db.run("INSERT INTO alarm (id, session_id, kind, fire_at, encoding_version, status, time_created, time_updated) VALUES ('armed-alarm', 'legacy', 'at', 5000000000000, 1, 'armed', 1, 1)");
  db.run("INSERT INTO event_chain (event_type, event_hash, prev_hash, time_created) VALUES ('historical', 'opaque-original-hash', 'opaque-original-parent', 1)");
  db.run("INSERT INTO worker_run_state (run_id, session_id, agent_name, status, title, prompt, time_created, time_updated) VALUES ('frozen-worker', 'legacy', 'historic', 'completed', 'frozen', 'original prompt', 1, 1)");
  const appended = Ledger.append(db, { streamId: "wait:retired", type: "wait.opened", data: { ownerKind: "workItem", ownerId: "historical" }, timeCreated: 1 }, 0);
  if (appended.kind !== "appended") throw new Error("fixture history append failed");
  createSqliteWaitAdapter(db).create(Wait.Record.parse({
    id: "preserved", ownerRef: { kind: "session", id: "legacy" }, originMessageId: "preserved-outbound",
    correlation: { replyToMessageId: "preserved-platform-receipt" }, allowedActions: ["report_result"],
    expectedResponders: ["alice"], resolutionPolicy: "first_reply", status: "open", partial: false,
    replies: [], revision: 0, expiresAt: 5000000000000, followUpWindow: 100, createdAt: 1, updatedAt: 1,
  }));
  return {
    db,
    path,
    directory,
    archive: join(directory, "archive.sqlite"),
    manifest: join(directory, "manifest.json"),
    [Symbol.dispose]() {
      db.close();
      rmSync(directory, { recursive: true });
      if (existsSync(directory)) throw new Error(`fixture teardown failed: ${directory}`);
      if (reportCleanup) console.log(JSON.stringify({ cleanup: directory, removed: true }));
    },
  };
}

export function seedRetiredWait(db: Database, status: Wait.Record["status"] = "cancelled") {
  const record = Wait.Record.parse({
    id: "retired", ownerRef: { kind: "session", id: "historical" }, originMessageId: "outbound",
    correlation: { replyToMessageId: "platform-receipt" }, allowedActions: ["report_result"],
    expectedResponders: ["alice"], resolutionPolicy: "first_reply", status, partial: false,
    replies: status === "resolved" ? [{ replyKey: "reply", responderId: "alice", receivedAt: 2 }] : [],
    revision: status === "open" ? 0 : 1, expiresAt: 10, followUpWindow: 100,
    createdAt: 1, updatedAt: status === "expired" ? 11 : 2,
    ...(status === "cancelled" ? { cancelledAt: 2 } : {}),
    ...(status === "resolved" ? { resolvedAt: 2 } : {}),
  });
  createSqliteWaitAdapter(db).create(record);
  db.run("UPDATE wait SET owner_kind = 'workItem', data = json_set(data, '$.ownerRef.kind', 'workItem') WHERE id = 'retired'");
}

export function snapshotDatabase(db: Database) {
  const schema = db.query<{ name: string; type: string; sql: string | null }, []>("SELECT name, type, sql FROM sqlite_master ORDER BY name").all();
  const tables = schema.filter((row) => row.type === "table").map(({ name }) => {
    const statement = db.prepare<Record<string, string | bigint | number | Uint8Array | null>, []>(`SELECT rowid, * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`);
    try { return { name, rows: statement.all() }; } finally { statement.finalize(); }
  });
  return { schema, tables };
}
