import type { Database } from "bun:sqlite";
import type { Message } from "@openomni/protocol";
import type { Storage } from "./storage";

export function createSqlitePartAdapter(db: Database): Storage.Adapter["part"] {
  return {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const row = db
        .query("SELECT data FROM part WHERE id = ? AND message_id = ?")
        .get(partID, messageID) as { data: string } | null;
      return row ? (JSON.parse(row.data) as Message.Part) : undefined;
    },

    set: (messageID: string, part: Message.Part): void => {
      const timeStart = getPartStartTime(part) ?? null;
      db.query(
        `INSERT INTO part (id, message_id, data, type, time_start)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           message_id = excluded.message_id,
           data = excluded.data,
           type = excluded.type,
           time_start = excluded.time_start`,
      ).run(part.id, messageID, JSON.stringify(part), part.type ?? null, timeStart);
    },

    list: (messageID: string): Message.Part[] => {
      const rows = db
        .query("SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC")
        .all(messageID) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as Message.Part);
    },

    listByMessageIDs: (messageIDs: string[]): Message.Part[] => {
      if (messageIDs.length === 0) return [];
      const placeholders = messageIDs.map(() => "?").join(", ");
      // dynamic IN — can't cache this prepared statement
      const rows = db
        .prepare(`SELECT data FROM part WHERE message_id IN (${placeholders}) ORDER BY rowid ASC`)
        .all(...messageIDs) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as Message.Part);
    },

    remove: (messageID: string, partID: string): boolean => {
      const result = db
        .query("DELETE FROM part WHERE id = ? AND message_id = ?")
        .run(partID, messageID);
      return result.changes > 0;
    },
  };
}

// merged from part-time.ts (#453 hygiene: sub-30-LOC single-importer)

export function getPartStartTime(part: Message.Part): number | undefined {
  if ((part.type === "text" || part.type === "reasoning") && part.time?.start !== undefined) {
    return part.time.start;
  }

  if (
    part.type === "tool" &&
    part.state.status !== "pending" &&
    part.state.time?.start !== undefined
  ) {
    return part.state.time.start;
  }

  return undefined;
}
