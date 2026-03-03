import { Database } from "bun:sqlite";
import { Message } from "@openomni/protocol";
import { getPartStartTime } from "./part-time";
import { SessionInfo } from "../session/info";
import { Storage } from "./storage";

type DataRow = {
  data: string;
};

export class SqliteStorageAdapter implements Storage.Adapter {
  private readonly db: Database;

  private readonly sessionStatements: {
    get: ReturnType<Database["query"]>;
    set: ReturnType<Database["query"]>;
    list: ReturnType<Database["query"]>;
    remove: ReturnType<Database["query"]>;
  };

  private readonly messageStatements: {
    get: ReturnType<Database["query"]>;
    set: ReturnType<Database["query"]>;
    list: ReturnType<Database["query"]>;
    remove: ReturnType<Database["query"]>;
  };

  private readonly partStatements: {
    get: ReturnType<Database["query"]>;
    set: ReturnType<Database["query"]>;
    list: ReturnType<Database["query"]>;
    remove: ReturnType<Database["query"]>;
  };

  private readonly maintenanceStatements: {
    clearParts: ReturnType<Database["query"]>;
    clearMessages: ReturnType<Database["query"]>;
    clearSessions: ReturnType<Database["query"]>;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.query("PRAGMA journal_mode = WAL").run();
    this.db.query("PRAGMA synchronous = NORMAL").run();
    this.db.query("PRAGMA busy_timeout = 5000").run();

    this.db
      .query(
        "CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, data TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
      )
      .run();
    this.db
      .query(
        "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL)",
      )
      .run();
    this.db
      .query(
        "CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id)",
      )
      .run();
    this.db
      .query(
        "CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL, time_start INTEGER)",
      )
      .run();
    this.db
      .query("CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id)")
      .run();

    this.sessionStatements = {
      get: this.db.query("SELECT data FROM session WHERE id = ?"),
      set: this.db.query(
        "INSERT OR REPLACE INTO session (id, data, time_created, time_updated) VALUES (?, ?, ?, ?)",
      ),
      list: this.db.query("SELECT data FROM session"),
      remove: this.db.query("DELETE FROM session WHERE id = ?"),
    };

    this.messageStatements = {
      get: this.db.query(
        "SELECT data FROM message WHERE id = ? AND session_id = ?",
      ),
      set: this.db.query(
        "INSERT OR REPLACE INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)",
      ),
      list: this.db.query(
        "SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
      ),
      remove: this.db.query(
        "DELETE FROM message WHERE id = ? AND session_id = ?",
      ),
    };

    this.partStatements = {
      get: this.db.query(
        "SELECT data FROM part WHERE id = ? AND message_id = ?",
      ),
      set: this.db.query(
        "INSERT OR REPLACE INTO part (id, message_id, data, time_start) VALUES (?, ?, ?, ?)",
      ),
      list: this.db.query(
        "SELECT data FROM part WHERE message_id = ? ORDER BY CASE WHEN time_start IS NOT NULL THEN 0 ELSE 1 END, time_start ASC, id ASC",
      ),
      remove: this.db.query("DELETE FROM part WHERE id = ? AND message_id = ?"),
    };

    this.maintenanceStatements = {
      clearParts: this.db.query("DELETE FROM part"),
      clearMessages: this.db.query("DELETE FROM message"),
      clearSessions: this.db.query("DELETE FROM session"),
    };
  }

  private parseData<T>(row: DataRow | null): T | undefined {
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.data) as T;
  }


  session = {
    get: (id: string): SessionInfo | undefined => {
      const row = this.sessionStatements.get.get(id) as DataRow | null;
      return this.parseData<SessionInfo>(row);
    },

    set: (id: string, info: SessionInfo): void => {
      this.sessionStatements.set.run(
        id,
        JSON.stringify(info),
        info.time.created,
        info.time.updated,
      );
    },

    list: (): SessionInfo[] => {
      const rows = this.sessionStatements.list.all() as DataRow[];
      return rows.map((row) => JSON.parse(row.data) as SessionInfo);
    },

    remove: (id: string): boolean => {
      const result = this.sessionStatements.remove.run(id);
      return result.changes > 0;
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const row = this.messageStatements.get.get(
        messageID,
        sessionID,
      ) as DataRow | null;
      return this.parseData<Message.Info>(row);
    },

    set: (sessionID: string, message: Message.Info): void => {
      this.messageStatements.set.run(
        message.id,
        sessionID,
        JSON.stringify(message),
        message.time.created,
      );
    },

    list: (sessionID: string): Message.Info[] => {
      const rows = this.messageStatements.list.all(sessionID) as DataRow[];
      return rows.map((row) => JSON.parse(row.data) as Message.Info);
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const result = this.messageStatements.remove.run(messageID, sessionID);
      return result.changes > 0;
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const row = this.partStatements.get.get(
        partID,
        messageID,
      ) as DataRow | null;
      return this.parseData<Message.Part>(row);
    },

    set: (messageID: string, part: Message.Part): void => {
      const timeStart = getPartStartTime(part);
      this.partStatements.set.run(
        part.id,
        messageID,
        JSON.stringify(part),
        timeStart ?? null,
      );
    },

    list: (messageID: string): Message.Part[] => {
      const rows = this.partStatements.list.all(messageID) as DataRow[];
      return rows.map((row) => JSON.parse(row.data) as Message.Part);
    },

    remove: (messageID: string, partID: string): boolean => {
      const result = this.partStatements.remove.run(partID, messageID);
      return result.changes > 0;
    },
  };

  clear(): void {
    this.maintenanceStatements.clearParts.run();
    this.maintenanceStatements.clearMessages.run();
    this.maintenanceStatements.clearSessions.run();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
