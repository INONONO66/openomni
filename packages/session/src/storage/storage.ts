import type { Message } from "@openomni/protocol";
import type { SessionInfo } from "../session/info";
import { SqliteStorageAdapter } from "./sqlite-storage";

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
      findByStatus?(status: string): Array<{ id: string; sessionId: string }>;
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
      listBySession?(sessionId: string): string[];
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
    backgroundTask?: {
      upsert(
        id: string,
        status: string,
        parentSessionId: string,
        data: string,
        output?: string,
      ): void;
      get(id: string): { data: string; status: string; output?: string } | undefined;
      listByStatus(
        ...statuses: string[]
      ): Array<{ id: string; data: string; status: string; output?: string }>;
    };
  }
}

export namespace Storage {
  let adapter: Adapter = new SqliteStorageAdapter(process.env.OPENOMNI_DB_PATH ?? ":memory:");

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
    adapter = new SqliteStorageAdapter(":memory:");
  }
}
