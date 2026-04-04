import type { Message } from "@openomni/protocol";
import type { SessionInfo } from "../session/info";
import type { Storage } from "./storage";

export class CachedStorageAdapter implements Storage.Adapter {
  private sessionCache = new Map<string, SessionInfo>();
  private sessionListCache: SessionInfo[] | null = null;
  private messageCache = new Map<string, Message.Info[]>();
  private partCache = new Map<string, Message.Part[]>();

  constructor(private readonly underlying: Storage.Adapter & { clear?: () => void }) {}

  session = {
    get: (id: string): SessionInfo | undefined => {
      const cached = this.sessionCache.get(id);
      if (cached !== undefined) return cached;

      const result = this.underlying.session.get(id);
      if (result !== undefined) this.sessionCache.set(id, result);
      return result;
    },

    set: (id: string, info: SessionInfo): void => {
      this.underlying.session.set(id, info);
      this.sessionCache.set(id, info);
      this.sessionListCache = null;
    },

    list: (): SessionInfo[] => {
      if (this.sessionListCache !== null) return this.sessionListCache;

      const result = this.underlying.session.list();
      this.sessionListCache = result;
      return result;
    },

    remove: (id: string): boolean => {
      const result = this.underlying.session.remove(id);
      this.sessionCache.delete(id);
      this.sessionListCache = null;
      return result;
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const msgs = this.message.list(sessionID);
      return msgs.find((m) => m.id === messageID);
    },

    set: (sessionID: string, message: Message.Info): void => {
      this.underlying.message.set(sessionID, message);

      const cached = this.messageCache.get(sessionID);
      if (cached !== undefined) {
        const idx = cached.findIndex((m) => m.id === message.id);
        if (idx >= 0) cached[idx] = message;
        else cached.push(message);
      } else {
        this.messageCache.delete(sessionID);
      }
    },

    list: (sessionID: string): Message.Info[] => {
      const cached = this.messageCache.get(sessionID);
      if (cached !== undefined) return cached;

      const result = this.underlying.message.list(sessionID);
      this.messageCache.set(sessionID, result);
      return result;
    },

    listPage: (
      sessionID: string,
      options: { limit: number; before?: string },
    ): Storage.MessagePage => {
      if (this.underlying.message.listPage) {
        return this.underlying.message.listPage(sessionID, options);
      }

      const all = this.message.list(sessionID);
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
      const result = this.underlying.message.remove(sessionID, messageID);
      this.messageCache.delete(sessionID);
      return result;
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const pts = this.part.list(messageID);
      return pts.find((p) => p.id === partID);
    },

    set: (messageID: string, part: Message.Part): void => {
      this.underlying.part.set(messageID, part);

      const cached = this.partCache.get(messageID);
      if (cached !== undefined) {
        const idx = cached.findIndex((p) => p.id === part.id);
        if (idx >= 0) cached[idx] = part;
        else cached.push(part);
      } else {
        this.partCache.delete(messageID);
      }
    },

    list: (messageID: string): Message.Part[] => {
      const cached = this.partCache.get(messageID);
      if (cached !== undefined) return cached;

      const result = this.underlying.part.list(messageID);
      this.partCache.set(messageID, result);
      return result;
    },

    listByMessageIDs: (messageIDs: string[]): Message.Part[] => {
      if (this.underlying.part.listByMessageIDs) {
        return this.underlying.part.listByMessageIDs(messageIDs);
      }

      const result: Message.Part[] = [];
      for (const messageID of messageIDs) {
        result.push(...this.part.list(messageID));
      }
      return result;
    },

    remove: (messageID: string, partID: string): boolean => {
      const result = this.underlying.part.remove(messageID, partID);
      this.partCache.delete(messageID);
      return result;
    },
  };

  clear(): void {
    this.sessionCache.clear();
    this.sessionListCache = null;
    this.messageCache.clear();
    this.partCache.clear();
    if ("clear" in this.underlying && typeof this.underlying.clear === "function") {
      this.underlying.clear();
    }
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
