import { z } from "zod";
import { Message } from "@openomni/protocol";
import { SessionInfo } from "./info";
import { Storage } from "../storage/storage";
import { Bus, BusEvent } from "../bus";

export namespace Session {
  export const Info = SessionInfo;
  export type Info = SessionInfo;

  export const Event = {
    Created: BusEvent.define("session.created", z.object({ info: Info })),
    Updated: BusEvent.define("session.updated", z.object({ info: Info })),
    Deleted: BusEvent.define("session.deleted", z.object({ id: z.string() })),
  };

  // Backward compatibility: tests access Session["storage"].clear()
  export const storage = {
    clear() {
      Storage.reset();
    },
    get(id: string) {
      return Storage.getAdapter().session.get(id);
    },
    set(id: string, info: Info) {
      Storage.getAdapter().session.set(id, info);
    },
    has(id: string) {
      return Storage.getAdapter().session.get(id) !== undefined;
    },
    delete(id: string) {
      return Storage.getAdapter().session.remove(id);
    },
    values() {
      return Storage.getAdapter().session.list()[Symbol.iterator]();
    },
  };

  // Backward compatibility: tests access Session["messages"].clear()
  export const messages = {
    clear() {
      Storage.reset();
    },
    get(sessionID: string) {
      return Storage.getAdapter().message.list(sessionID);
    },
    set(sessionID: string, msgs: Message.Info[]) {
      const adapter = Storage.getAdapter();
      const existing = adapter.message.list(sessionID);
      for (const msg of existing) {
        adapter.message.remove(sessionID, msg.id);
      }
      for (const msg of msgs) {
        adapter.message.set(sessionID, msg);
      }
    },
    has(sessionID: string) {
      return Storage.getAdapter().message.list(sessionID).length > 0;
    },
    delete(sessionID: string) {
      const adapter = Storage.getAdapter();
      const msgs = adapter.message.list(sessionID);
      for (const msg of msgs) {
        adapter.message.remove(sessionID, msg.id);
      }
      return msgs.length > 0;
    },
  };

  export function create(input: {
    title: string;
    model: { providerID: string; modelID: string };
    ttlMs?: number;
  }): Info {
    const id = crypto.randomUUID();
    const now = Date.now();

    const session: Info = {
      id,
      title: input.title,
      model: input.model,
      time: {
        created: now,
        updated: now,
      },
      ...(input.ttlMs !== undefined && { expiresAt: now + input.ttlMs }),
    };

    Storage.getAdapter().session.set(id, session);
    Bus.publish(Event.Created, { info: session });

    return session;
  }

  export function get(id: string): Info | undefined {
    const session = Storage.getAdapter().session.get(id);
    if (!session) return undefined;

    if (session.expiresAt !== undefined && Date.now() > session.expiresAt) {
      remove(id);
      return undefined;
    }

    return session;
  }

  export function list(): Info[] {
    const sessions = Storage.getAdapter().session.list();
    const now = Date.now();

    return sessions.filter((session) => {
      if (session.expiresAt !== undefined && now > session.expiresAt) {
        remove(session.id);
        return false;
      }
      return true;
    });
  }

  export function update(
    id: string,
    input: Partial<Omit<Info, "id" | "time">> & {
      time?: Partial<Info["time"]>;
    },
  ): Info | undefined {
    const session = Storage.getAdapter().session.get(id);
    if (!session) return undefined;

    const updated: Info = {
      ...session,
      ...input,
      time: {
        ...session.time,
        updated: Date.now(),
        ...(input.time || {}),
      },
    };

    Storage.getAdapter().session.set(id, updated);
    Bus.publish(Event.Updated, { info: updated });
    return updated;
  }

  export function remove(id: string): boolean {
    const adapter = Storage.getAdapter();
    const exists = adapter.session.get(id) !== undefined;
    if (exists) {
      const msgs = adapter.message.list(id);
      for (const msg of msgs) {
        const parts = adapter.part.list(msg.id);
        for (const part of parts) {
          adapter.part.remove(msg.id, part.id);
        }
        adapter.message.remove(id, msg.id);
      }
      adapter.session.remove(id);
      Bus.publish(Event.Deleted, { id });
    }
    return exists;
  }

  export function addMessage(sessionID: string, message: Message.Info): void {
    Storage.getAdapter().message.set(sessionID, message);

    const session = Storage.getAdapter().session.get(sessionID);
    if (!session) return;

    const updated: Info = {
      ...session,
      messageCount: (session.messageCount ?? 0) + 1,
      time: {
        ...session.time,
        updated: Date.now(),
      },
      ...(message.role === "assistant" && {
        tokens: (() => {
          const input =
            (session.tokens?.input ?? 0) + message.tokens.input;
          const output =
            (session.tokens?.output ?? 0) + message.tokens.output;
          return { input, output, total: input + output };
        })(),
      }),
    };

    Storage.getAdapter().session.set(sessionID, updated);
    Bus.publish(Event.Updated, { info: updated });
  }

  export function getMessages(sessionID: string): Message.Info[] {
    return Storage.getAdapter().message.list(sessionID);
  }

  export function addPart(messageID: string, part: Message.Part): void {
    Storage.getAdapter().part.set(messageID, part);
  }

  export function getParts(messageID: string): Message.Part[] {
    return Storage.getAdapter().part.list(messageID);
  }
}
