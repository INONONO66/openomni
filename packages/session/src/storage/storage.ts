import type { Message } from "@openomni/protocol";
import type { SessionInfo } from "../session/info";

export namespace Storage {
  export type MessagePage = {
    items: Message.Info[];
    nextCursor: string | null;
    more: boolean;
  };

  export interface Adapter {
    session: {
      get(id: string): SessionInfo | undefined;
      set(id: string, info: SessionInfo): void;
      list(): SessionInfo[];
      remove(id: string): boolean;
    };
    message: {
      get(sessionID: string, messageID: string): Message.Info | undefined;
      set(sessionID: string, message: Message.Info): void;
      list(sessionID: string): Message.Info[];
      listPage?(sessionID: string, options: { limit: number; before?: string }): MessagePage;
      remove(sessionID: string, messageID: string): boolean;
      setStatus?(messageID: string, status: string): void;
    };
    part: {
      get(messageID: string, partID: string): Message.Part | undefined;
      set(messageID: string, part: Message.Part): void;
      list(messageID: string): Message.Part[];
      listByMessageIDs?(messageIDs: string[]): Message.Part[];
      remove(messageID: string, partID: string): boolean;
    };

    surfaceKey?: {
      register(key: string, sessionId: string): void;
      lookup(key: string): string | undefined;
      delete(key: string): void;
    };
    artifact?: {
      store(id: string, sessionId: string, meta: string, content: string): void;
      get(id: string): { meta: string; content: string; sessionId: string } | undefined;
      list(sessionId: string): Array<{ id: string; meta: string; content: string }>;
      delete(id: string): void;
    };
    eventLog?: {
      append(sessionId: string, type: string, data: string): number;
      replay(sessionId: string): Array<{ id: number; type: string; status: string; data: string }>;
      listIncomplete(sessionId: string): Array<{ id: number; type: string; data: string }>;
      markComplete(sessionId: string, eventId: number): void;
      listIncompleteSessions(): string[];
    };
  }
}

export class InMemoryStorage implements Storage.Adapter {
  private sessions = new Map<string, SessionInfo>();
  private messages = new Map<string, Message.Info[]>();
  private parts = new Map<string, Message.Part[]>();
  private artifacts = new Map<string, { sessionId: string; meta: string; content: string }>();
  private eventLogs = new Map<
    string,
    Array<{ id: number; type: string; status: string; data: string }>
  >();
  private eventLogSeq = 0;

  session = {
    get: (id: string): SessionInfo | undefined => {
      return this.sessions.get(id);
    },
    set: (id: string, info: SessionInfo): void => {
      this.sessions.set(id, info);
    },
    list: (): SessionInfo[] => {
      return Array.from(this.sessions.values());
    },
    remove: (id: string): boolean => {
      return this.sessions.delete(id);
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const msgs = this.messages.get(sessionID);
      return msgs?.find((m) => m.id === messageID);
    },
    set: (sessionID: string, message: Message.Info): void => {
      const msgs = this.messages.get(sessionID) ?? [];
      const idx = msgs.findIndex((m) => m.id === message.id);
      if (idx >= 0) {
        msgs[idx] = message;
      } else {
        msgs.push(message);
      }
      this.messages.set(sessionID, msgs);
    },
    list: (sessionID: string): Message.Info[] => {
      return this.messages.get(sessionID) ?? [];
    },
    listPage: (
      sessionID: string,
      options: { limit: number; before?: string },
    ): Storage.MessagePage => {
      const all = [...(this.messages.get(sessionID) ?? [])].sort(
        (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
      );

      const candidates = options.before
        ? (() => {
            const cursor = decodeCursor(options.before);
            return all.filter(
              (m) =>
                m.time.created < cursor.time ||
                (m.time.created === cursor.time && m.id.localeCompare(cursor.id) < 0),
            );
          })()
        : all;

      const tailWithExtra = candidates.slice(Math.max(0, candidates.length - (options.limit + 1)));
      const more = tailWithExtra.length > options.limit;
      const items = more ? tailWithExtra.slice(1) : tailWithExtra;
      const head = items[0];

      return {
        items,
        more,
        nextCursor: more && head ? encodeCursor(head.id, head.time.created) : null,
      };
    },
    remove: (sessionID: string, messageID: string): boolean => {
      const msgs = this.messages.get(sessionID);
      if (!msgs) return false;
      const idx = msgs.findIndex((m) => m.id === messageID);
      if (idx < 0) return false;
      msgs.splice(idx, 1);
      return true;
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const pts = this.parts.get(messageID);
      return pts?.find((p) => p.id === partID);
    },
    set: (messageID: string, part: Message.Part): void => {
      const pts = this.parts.get(messageID) ?? [];
      const idx = pts.findIndex((p) => p.id === part.id);
      if (idx >= 0) {
        pts[idx] = part;
      } else {
        pts.push(part);
      }
      this.parts.set(messageID, pts);
    },
    list: (messageID: string): Message.Part[] => {
      return this.parts.get(messageID) ?? [];
    },
    listByMessageIDs: (messageIDs: string[]): Message.Part[] => {
      const result: Message.Part[] = [];
      for (const messageID of messageIDs) {
        result.push(...(this.parts.get(messageID) ?? []));
      }
      return result;
    },
    remove: (messageID: string, partID: string): boolean => {
      const pts = this.parts.get(messageID);
      if (!pts) return false;
      const idx = pts.findIndex((p) => p.id === partID);
      if (idx < 0) return false;
      pts.splice(idx, 1);
      return true;
    },
  };

  artifact = {
    store: (id: string, sessionId: string, meta: string, content: string): void => {
      this.artifacts.set(id, { sessionId, meta, content });
    },
    get: (id: string): { meta: string; content: string; sessionId: string } | undefined => {
      return this.artifacts.get(id);
    },
    list: (sessionId: string): Array<{ id: string; meta: string; content: string }> => {
      const result: Array<{ id: string; meta: string; content: string }> = [];
      for (const [id, entry] of this.artifacts) {
        if (entry.sessionId === sessionId) {
          result.push({ id, meta: entry.meta, content: entry.content });
        }
      }
      return result;
    },
    delete: (id: string): void => {
      this.artifacts.delete(id);
    },
  };

  eventLog = {
    append: (sessionId: string, type: string, data: string): number => {
      const id = ++this.eventLogSeq;
      const logs = this.eventLogs.get(sessionId) ?? [];
      logs.push({ id, type, status: "pending", data });
      this.eventLogs.set(sessionId, logs);
      return id;
    },
    replay: (
      sessionId: string,
    ): Array<{ id: number; type: string; status: string; data: string }> => {
      return this.eventLogs.get(sessionId) ?? [];
    },
    listIncomplete: (sessionId: string): Array<{ id: number; type: string; data: string }> => {
      const logs = this.eventLogs.get(sessionId) ?? [];
      return logs
        .filter((e) => e.status !== "completed")
        .map(({ id, type, data }) => ({ id, type, data }));
    },
    markComplete: (_sessionId: string, eventId: number): void => {
      for (const logs of this.eventLogs.values()) {
        const entry = logs.find((e) => e.id === eventId);
        if (entry) {
          entry.status = "completed";
          return;
        }
      }
    },
    listIncompleteSessions: (): string[] => {
      const result: string[] = [];
      for (const [sessionId, logs] of this.eventLogs) {
        if (logs.some((e) => e.status !== "completed")) {
          result.push(sessionId);
        }
      }
      return result;
    },
  };

  clear(): void {
    this.sessions.clear();
    this.messages.clear();
    this.parts.clear();
    this.artifacts.clear();
    this.eventLogs.clear();
    this.eventLogSeq = 0;
  }
}

export namespace Storage {
  let adapter: Adapter = new InMemoryStorage();

  export function configure(newAdapter: Adapter): void {
    adapter = newAdapter;
  }

  export function get(): Adapter {
    return adapter;
  }

  export function getAdapter(): Adapter {
    return adapter;
  }

  export function reset(): void {
    adapter = new InMemoryStorage();
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
