import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { sqliteJsonData } from "./sqlite-json-data";

const BlacklistRow = sqliteJsonData(Actor.BlacklistEntry);

export function createSqliteBlacklistAdapter(db: Database): ProtocolStorage.BlacklistSubAdapter {
  return {
    get(id) {
      const row = BlacklistRow.nullable().parse(
        db.query("SELECT data FROM blacklist WHERE id = ?").get(id),
      );
      return row ?? undefined;
    },
    set(entry) {
      const now = Date.now();
      db.query(
        `INSERT INTO blacklist (
           id, data, kind, value, expires_at, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           kind = excluded.kind,
           value = excluded.value,
           expires_at = excluded.expires_at,
           time_updated = excluded.time_updated`,
      ).run(
        entry.id,
        JSON.stringify(entry),
        entry.kind,
        entry.value,
        entry.expiresAt ?? null,
        entry.createdAt ?? now,
        entry.updatedAt ?? now,
      );
    },
    list() {
      return BlacklistRow.array().parse(
        db.query("SELECT data FROM blacklist ORDER BY time_created ASC, id ASC").all(),
      );
    },
    remove(id) {
      return db.query("DELETE FROM blacklist WHERE id = ?").run(id).changes > 0;
    },
  };
}
