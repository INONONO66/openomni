import type { Database } from "bun:sqlite";
import { Message } from "@openomni/protocol";
import type { Storage } from "./storage";

// Parse-don't-cast on read: a corrupt row is a loud typed defect, never a
// silently-trusted value (matches the wait/blacklist precedent).
function decodeMessage(data: string): Message.Info {
  return Message.Info.parse(JSON.parse(data));
}

export function createSqliteMessageAdapter(db: Database): Storage.Adapter["message"] {
  return {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const row = db
        .query("SELECT data FROM message WHERE id = ? AND session_id = ?")
        .get(messageID, sessionID) as { data: string } | null;
      return row ? decodeMessage(row.data) : undefined;
    },

    set: (sessionID: string, message: Message.Info): void => {
      // status is intentionally omitted from the UPDATE set — preserved across upserts
      db.query(
        `INSERT INTO message (id, session_id, data, role, time_created)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           data = excluded.data,
           role = excluded.role,
           time_created = excluded.time_created`,
      ).run(
        message.id,
        sessionID,
        JSON.stringify(message),
        message.role ?? null,
        message.time.created,
      );
    },

    list: (sessionID: string): Message.Info[] => {
      const rows = db
        .query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC")
        .all(sessionID) as Array<{ data: string }>;
      return rows.map((r) => decodeMessage(r.data));
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const result = db
        .query("DELETE FROM message WHERE id = ? AND session_id = ?")
        .run(messageID, sessionID);
      return result.changes > 0;
    },

    setStatus: (messageID: string, status: string): void => {
      db.query("UPDATE message SET status = ? WHERE id = ?").run(status, messageID);
    },

    findByStatus: (status: string): Array<{ id: string; sessionId: string }> => {
      const rows = db
        .query("SELECT id, session_id FROM message WHERE status = ?")
        .all(status) as Array<{ id: string; session_id: string }>;
      return rows.map((r) => ({ id: r.id, sessionId: r.session_id }));
    },
  };
}
