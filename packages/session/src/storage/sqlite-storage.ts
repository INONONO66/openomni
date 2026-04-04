import type { Database } from "bun:sqlite";
import { eq, and, ne, asc, desc, lt, or, inArray, sql } from "drizzle-orm";
import type { Message } from "@openomni/protocol";
import { getPartStartTime } from "./part-time";
import type { SessionInfo } from "../session/info";
import type { Storage } from "./storage";
import { createDb, type DrizzleDb } from "./drizzle/db";
import {
  sessionTable,
  messageTable,
  partTable,
  surfaceKeyTable,
  artifactTable,
  eventLogTable,
} from "./drizzle/schema";

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

    listPage: (
      sessionID: string,
      options: { limit: number; before?: string },
    ): Storage.MessagePage => {
      const cursor = options.before ? decodeCursor(options.before) : undefined;
      const where = cursor
        ? and(
            eq(messageTable.session_id, sessionID),
            or(
              lt(messageTable.time_created, cursor.time),
              and(eq(messageTable.time_created, cursor.time), lt(messageTable.id, cursor.id)),
            ),
          )
        : eq(messageTable.session_id, sessionID);

      const rows = this.db
        .select({
          id: messageTable.id,
          time_created: messageTable.time_created,
          data: messageTable.data,
        })
        .from(messageTable)
        .where(where)
        .orderBy(desc(messageTable.time_created), desc(messageTable.id))
        .limit(options.limit + 1)
        .all();

      const more = rows.length > options.limit;
      const page = more ? rows.slice(0, options.limit) : rows;
      const items = page.map((row) => JSON.parse(row.data) as Message.Info).reverse();
      const tail = page.at(-1);

      return {
        items,
        more,
        nextCursor: more && tail ? encodeCursor(tail.id, tail.time_created) : null,
      };
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const deleted = this.db
        .delete(messageTable)
        .where(and(eq(messageTable.id, messageID), eq(messageTable.session_id, sessionID)))
        .returning({ id: messageTable.id })
        .all();
      return deleted.length > 0;
    },

    setStatus: (messageID: string, status: string): void => {
      this.db.update(messageTable).set({ status }).where(eq(messageTable.id, messageID)).run();
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

    listByMessageIDs: (messageIDs: string[]): Message.Part[] => {
      if (messageIDs.length === 0) {
        return [];
      }

      const rows = this.db
        .select({ data: partTable.data })
        .from(partTable)
        .where(inArray(partTable.message_id, messageIDs))
        .orderBy(
          asc(partTable.message_id),
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

  surfaceKey = {
    register: (key: string, sessionId: string): void => {
      const now = Date.now();
      this.db
        .insert(surfaceKeyTable)
        .values({ key, session_id: sessionId, time_created: now })
        .onConflictDoUpdate({
          target: surfaceKeyTable.key,
          set: { session_id: sessionId, time_created: now },
        })
        .run();
    },

    lookup: (key: string): string | undefined => {
      const row = this.db
        .select({ session_id: surfaceKeyTable.session_id })
        .from(surfaceKeyTable)
        .where(eq(surfaceKeyTable.key, key))
        .get();
      return row?.session_id;
    },

    delete: (key: string): void => {
      this.db.delete(surfaceKeyTable).where(eq(surfaceKeyTable.key, key)).run();
    },
  };

  artifact = {
    store: (id: string, sessionId: string, meta: string, content: string): void => {
      const now = Date.now();
      this.db
        .insert(artifactTable)
        .values({
          id,
          session_id: sessionId,
          meta,
          content,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: artifactTable.id,
          set: { session_id: sessionId, meta, content, time_updated: now },
        })
        .run();
    },

    get: (id: string): { meta: string; content: string; sessionId: string } | undefined => {
      const row = this.db
        .select({
          meta: artifactTable.meta,
          content: artifactTable.content,
          sessionId: artifactTable.session_id,
        })
        .from(artifactTable)
        .where(eq(artifactTable.id, id))
        .get();
      return row ?? undefined;
    },

    list: (sessionId: string): Array<{ id: string; meta: string; content: string }> => {
      return this.db
        .select({
          id: artifactTable.id,
          meta: artifactTable.meta,
          content: artifactTable.content,
        })
        .from(artifactTable)
        .where(eq(artifactTable.session_id, sessionId))
        .all();
    },

    delete: (id: string): void => {
      this.db.delete(artifactTable).where(eq(artifactTable.id, id)).run();
    },
  };

  eventLog = {
    append: (sessionId: string, type: string, data: string): number => {
      const now = Date.now();
      const result = this.db
        .insert(eventLogTable)
        .values({ session_id: sessionId, type, data, time_created: now })
        .returning({ id: eventLogTable.id })
        .get();
      return result.id;
    },

    replay: (
      sessionId: string,
    ): Array<{ id: number; type: string; status: string; data: string }> => {
      return this.db
        .select({
          id: eventLogTable.id,
          type: eventLogTable.type,
          status: eventLogTable.status,
          data: eventLogTable.data,
        })
        .from(eventLogTable)
        .where(eq(eventLogTable.session_id, sessionId))
        .orderBy(asc(eventLogTable.id))
        .all();
    },

    listIncomplete: (sessionId: string): Array<{ id: number; type: string; data: string }> => {
      return this.db
        .select({
          id: eventLogTable.id,
          type: eventLogTable.type,
          data: eventLogTable.data,
        })
        .from(eventLogTable)
        .where(and(eq(eventLogTable.session_id, sessionId), ne(eventLogTable.status, "completed")))
        .orderBy(asc(eventLogTable.id))
        .all();
    },

    markComplete: (_sessionId: string, eventId: number): void => {
      this.db
        .update(eventLogTable)
        .set({ status: "completed" })
        .where(eq(eventLogTable.id, eventId))
        .run();
    },

    listIncompleteSessions: (): string[] => {
      const rows = this.db
        .selectDistinct({ session_id: eventLogTable.session_id })
        .from(eventLogTable)
        .where(ne(eventLogTable.status, "completed"))
        .all();
      return rows.map((r) => r.session_id);
    },
  };

  clear(): void {
    this.db.delete(eventLogTable).run();
    this.db.delete(artifactTable).run();
    this.db.delete(surfaceKeyTable).run();
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

function encodeCursor(id: string, time: number): string {
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url");
}

function decodeCursor(cursor: string): { id: string; time: number } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
    id: string;
    time: number;
  };
}
