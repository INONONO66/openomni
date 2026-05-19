import type { Database } from "bun:sqlite";
import type { Message } from "@openomni/protocol";
import type { Storage } from "./storage";

export function createSqliteMessageAdapter(db: Database): Storage.Adapter["message"] {
  return {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const row = db
        .query("SELECT data FROM message WHERE id = ? AND session_id = ?")
        .get(messageID, sessionID) as { data: string } | null;
      return row ? (JSON.parse(row.data) as Message.Info) : undefined;
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
      return rows.map((r) => JSON.parse(r.data) as Message.Info);
    },

    listPage: (
      sessionID: string,
      options: { limit: number; before?: string },
    ): Storage.MessagePage => {
      const cursor = options.before ? decodeCursor(options.before) : undefined;

      type Row = { id: string; time_created: number; data: string };
      let rows: Row[];

      if (cursor) {
        rows = db
          .query(
            `SELECT id, time_created, data FROM message
             WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
             ORDER BY time_created DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionID, cursor.time, cursor.time, cursor.id, options.limit + 1) as Row[];
      } else {
        rows = db
          .query(
            `SELECT id, time_created, data FROM message
             WHERE session_id = ?
             ORDER BY time_created DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionID, options.limit + 1) as Row[];
      }

      const more = rows.length > options.limit;
      const page = more ? rows.slice(0, options.limit) : rows;
      const items = page.map((r) => JSON.parse(r.data) as Message.Info).reverse();
      const tail = page.at(-1);

      return {
        items,
        more,
        nextCursor: more && tail ? encodeCursor(tail.id, tail.time_created) : null,
      };
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

function encodeCursor(id: string, time: number): string {
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url");
}

function decodeCursor(cursor: string): { id: string; time: number } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
    id: string;
    time: number;
  };
}
