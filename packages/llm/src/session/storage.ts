import { Session } from "./session";
import { Message } from "./message";

export interface StorageAdapter {
  session: {
    get(id: string): Session.Info | undefined;
    set(id: string, info: Session.Info): void;
    list(): Session.Info[];
    remove(id: string): boolean;
  };
  message: {
    get(sessionID: string, messageID: string): Message.Info | undefined;
    set(sessionID: string, message: Message.Info): void;
    list(sessionID: string): Message.Info[];
    remove(sessionID: string, messageID: string): boolean;
  };
  part: {
    get(messageID: string, partID: string): Message.Part | undefined;
    set(messageID: string, part: Message.Part): void;
    list(messageID: string): Message.Part[];
    remove(messageID: string, partID: string): boolean;
  };
}

export class InMemoryStorage implements StorageAdapter {
  private sessions = new Map<string, Session.Info>();
  private messages = new Map<string, Message.Info[]>();
  private parts = new Map<string, Message.Part[]>();

  session = {
    get: (id: string): Session.Info | undefined => {
      return this.sessions.get(id);
    },
    set: (id: string, info: Session.Info): void => {
      this.sessions.set(id, info);
    },
    list: (): Session.Info[] => {
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
    remove: (messageID: string, partID: string): boolean => {
      const pts = this.parts.get(messageID);
      if (!pts) return false;
      const idx = pts.findIndex((p) => p.id === partID);
      if (idx < 0) return false;
      pts.splice(idx, 1);
      return true;
    },
  };

  clear(): void {
    this.sessions.clear();
    this.messages.clear();
    this.parts.clear();
  }
}

export namespace Storage {
  let adapter: StorageAdapter = new InMemoryStorage();

  export function configure(newAdapter: StorageAdapter): void {
    adapter = newAdapter;
  }

  export function getAdapter(): StorageAdapter {
    return adapter;
  }

  export function reset(): void {
    adapter = new InMemoryStorage();
  }
}
