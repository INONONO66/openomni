import type { Database } from "bun:sqlite";
import { eq, and, asc, sql } from "drizzle-orm";
import type { Message } from "@openomni/protocol";
import { getPartStartTime } from "./part-time";
import type { SessionInfo } from "../session/info";
import type { Storage } from "./storage";
import { createDb, type DrizzleDb } from "./drizzle/db";
import { sessionTable, messageTable, partTable } from "./drizzle/schema";

export class SqliteStorageAdapter implements Storage.Adapter {
  private readonly db: DrizzleDb;
  private readonly sqlite: Database;

  constructor(dbPath: string) {
    const { db, sqlite } = createDb(dbPath);
    this.db = db;
    this.sqlite = sqlite;
  }

  private parseData<T>(row: { data: string } | undefined): T | undefined {
    if (!row) return undefined;
    return JSON.parse(row.data) as T;
  }

  session = {
    get: (id: string): SessionInfo | undefined => {
      const row = this.db
        .select({ data: sessionTable.data })
        .from(sessionTable)
        .where(eq(sessionTable.id, id))
        .get();
      return this.parseData<SessionInfo>(row);
    },

    set: (id: string, info: SessionInfo): void => {
      this.db
        .insert(sessionTable)
        .values({
          id,
          data: JSON.stringify(info),
          time_created: info.time.created,
          time_updated: info.time.updated,
        })
        .onConflictDoUpdate({
          target: sessionTable.id,
          set: {
            data: JSON.stringify(info),
            time_created: info.time.created,
            time_updated: info.time.updated,
          },
        })
        .run();
    },

    list: (): SessionInfo[] => {
      const rows = this.db.select({ data: sessionTable.data }).from(sessionTable).all();
      return rows.map((row) => JSON.parse(row.data) as SessionInfo);
    },

    remove: (id: string): boolean => {
      const deleted = this.db
        .delete(sessionTable)
        .where(eq(sessionTable.id, id))
        .returning({ id: sessionTable.id })
        .all();
      return deleted.length > 0;
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const row = this.db
        .select({ data: messageTable.data })
        .from(messageTable)
        .where(and(eq(messageTable.id, messageID), eq(messageTable.session_id, sessionID)))
        .get();
      return this.parseData<Message.Info>(row);
    },

    set: (sessionID: string, message: Message.Info): void => {
      this.db
        .insert(messageTable)
        .values({
          id: message.id,
          session_id: sessionID,
          data: JSON.stringify(message),
          role: message.role ?? null,
          time_created: message.time.created,
        })
        .onConflictDoUpdate({
          target: messageTable.id,
          set: {
            session_id: sessionID,
            data: JSON.stringify(message),
            role: message.role ?? null,
            time_created: message.time.created,
          },
        })
        .run();
    },

    list: (sessionID: string): Message.Info[] => {
      const rows = this.db
        .select({ data: messageTable.data })
        .from(messageTable)
        .where(eq(messageTable.session_id, sessionID))
        .orderBy(asc(messageTable.time_created), asc(messageTable.id))
        .all();
      return rows.map((row) => JSON.parse(row.data) as Message.Info);
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const deleted = this.db
        .delete(messageTable)
        .where(and(eq(messageTable.id, messageID), eq(messageTable.session_id, sessionID)))
        .returning({ id: messageTable.id })
        .all();
      return deleted.length > 0;
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const row = this.db
        .select({ data: partTable.data })
        .from(partTable)
        .where(and(eq(partTable.id, partID), eq(partTable.message_id, messageID)))
        .get();
      return this.parseData<Message.Part>(row);
    },

    set: (messageID: string, part: Message.Part): void => {
      const timeStart = getPartStartTime(part) ?? null;
      this.db
        .insert(partTable)
        .values({
          id: part.id,
          message_id: messageID,
          data: JSON.stringify(part),
          type: part.type ?? null,
          time_start: timeStart,
        })
        .onConflictDoUpdate({
          target: partTable.id,
          set: {
            message_id: messageID,
            data: JSON.stringify(part),
            type: part.type ?? null,
            time_start: timeStart,
          },
        })
        .run();
    },

    list: (messageID: string): Message.Part[] => {
      const rows = this.db
        .select({ data: partTable.data })
        .from(partTable)
        .where(eq(partTable.message_id, messageID))
        .orderBy(
          sql`CASE WHEN ${partTable.time_start} IS NOT NULL THEN 0 ELSE 1 END`,
          asc(partTable.time_start),
          asc(partTable.id),
        )
        .all();
      return rows.map((row) => JSON.parse(row.data) as Message.Part);
    },

    remove: (messageID: string, partID: string): boolean => {
      const deleted = this.db
        .delete(partTable)
        .where(and(eq(partTable.id, partID), eq(partTable.message_id, messageID)))
        .returning({ id: partTable.id })
        .all();
      return deleted.length > 0;
    },
  };

  clear(): void {
    this.db.delete(partTable).run();
    this.db.delete(messageTable).run();
    this.db.delete(sessionTable).run();
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  close(): void {
    this.sqlite.close();
  }
}
