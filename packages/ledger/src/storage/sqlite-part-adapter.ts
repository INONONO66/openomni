import type { Database } from "bun:sqlite";
import { Message } from "@openomni/protocol";
import type { Storage } from "./storage";

// Parse-don't-cast on read: a corrupt row is a loud typed defect, never a
// silently-trusted value (matches the wait/blacklist precedent).
function decodePart(data: string): Message.Part {
  return Message.Part.parse(JSON.parse(data));
}

export function createSqlitePartAdapter(db: Database): Storage.Adapter["part"] {
  return {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const row = db
        .query("SELECT data FROM part WHERE id = ? AND message_id = ?")
        .get(partID, messageID) as { data: string } | null;
      return row ? decodePart(row.data) : undefined;
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
      return rows.map((r) => decodePart(r.data));
    },

    remove: (messageID: string, partID: string): boolean => {
      const result = db
        .query("DELETE FROM part WHERE id = ? AND message_id = ?")
        .run(partID, messageID);
      return result.changes > 0;
    },
  };
}

function getPartStartTime(part: Message.Part): number | undefined {
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
