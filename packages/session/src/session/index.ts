import { z } from "zod";
import type { Message } from "@openomni/protocol";
import { SessionInfo } from "./info";
import { Storage } from "../storage/storage";
import { Bus, BusEvent } from "../bus";

export namespace Session {
  export type RecoveredMessage = {
    role: "assistant";
    text: string;
    timestamp: string;
    sequence: number;
    turnIndex: number;
  };

  export const Info = SessionInfo;
  export type Info = SessionInfo;

  export const Event = {
    Created: BusEvent.define("session.created", z.object({ info: Info })),
    Updated: BusEvent.define("session.updated", z.object({ info: Info })),
    Deleted: BusEvent.define("session.deleted", z.object({ id: z.string() })),
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
      spawnDepth: 0,
      ...(input.ttlMs !== undefined && { expiresAt: now + input.ttlMs }),
    };

    Storage.getAdapter().session.set(id, session);
    Bus.publish(Event.Created, { info: session });

    return session;
  }

  export function createChild(input: {
    parentSessionId: string;
    title: string;
    model: { providerID: string; modelID: string };
    workerMeta?: Record<string, unknown>;
  }): Info {
    const parent = get(input.parentSessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${input.parentSessionId}`);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const child: Info = {
      id,
      title: input.title,
      model: input.model,
      parentSessionId: input.parentSessionId,
      spawnDepth: parent.spawnDepth + 1,
      time: {
        created: now,
        updated: now,
      },
      ...(input.workerMeta !== undefined && { workerMeta: input.workerMeta }),
    };

    Storage.getAdapter().session.set(id, child);
    Bus.publish(Event.Created, { info: child });

    return child;
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

  export function listChildren(parentSessionId: string): Info[] {
    return list().filter((session) => session.parentSessionId === parentSessionId);
  }

  export function getWorkerMeta(sessionId: string): Record<string, unknown> | undefined {
    return get(sessionId)?.workerMeta;
  }

  export function updateWorkerMeta(sessionId: string, meta: Record<string, unknown>): void {
    update(sessionId, { workerMeta: meta });
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

  export function addMessage(
    sessionID: string,
    message: Message.Info,
    options?: { status?: "received" | "processing" | "completed" },
  ): void {
    const adapter = Storage.getAdapter();
    const session = adapter.session.get(sessionID);
    if (!session) return;

    const status = options?.status ?? "completed";

    adapter.message.set(sessionID, message);

    if (status !== "completed" && adapter.message.setStatus) {
      adapter.message.setStatus(message.id, status);
    }

    const updated: Info = {
      ...session,
      messageCount: (session.messageCount ?? 0) + 1,
      time: {
        ...session.time,
        updated: Date.now(),
      },
      ...(message.role === "assistant" && {
        tokens: (() => {
          const input = (session.tokens?.input ?? 0) + message.tokens.input;
          const output = (session.tokens?.output ?? 0) + message.tokens.output;
          return { input, output, total: input + output };
        })(),
      }),
    };

    adapter.session.set(sessionID, updated);
    Bus.publish(Event.Updated, { info: updated });
  }

  export function updateMessageStatus(
    messageID: string,
    status: "received" | "processing" | "completed",
  ): void {
    const adapter = Storage.getAdapter();
    if (adapter.message.setStatus) {
      adapter.message.setStatus(messageID, status);
    }
  }

  export function getMessages(sessionID: string): Message.Info[] {
    return Storage.getAdapter().message.list(sessionID);
  }

  export function listMessagesPage(
    sessionID: string,
    options: { limit: number; before?: string },
  ): { items: Message.Info[]; nextCursor: string | null; more: boolean } {
    const adapter = Storage.getAdapter();
    if (adapter.message.listPage) {
      return adapter.message.listPage(sessionID, options);
    }

    const all = [...adapter.message.list(sessionID)].sort(
      (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
    );

    const candidates = options.before
      ? (() => {
          let cursor: { id: string; time: number };
          try {
            cursor = decodeCursor(options.before);
          } catch {
            return all;
          }
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
  }

  export async function hydrateMessages(messages: Message.Info[]): Promise<Message.WithParts[]> {
    if (messages.length === 0) {
      return [];
    }

    const adapter = Storage.getAdapter();
    const messageIDs = messages.map((message) => message.id);

    const parts = adapter.part.listByMessageIDs
      ? adapter.part.listByMessageIDs(messageIDs)
      : messageIDs.flatMap((messageID) => adapter.part.list(messageID));

    const partsByMessageID = new Map<string, Message.Part[]>();
    for (const part of parts) {
      const existing = partsByMessageID.get(part.messageID);
      if (existing) {
        existing.push(part);
      } else {
        partsByMessageID.set(part.messageID, [part]);
      }
    }

    return messages.map((info) => ({
      info,
      parts: partsByMessageID.get(info.id) ?? [],
    }));
  }

  export function addPart(messageID: string, part: Message.Part): void {
    const adapter = Storage.getAdapter();
    adapter.part.set(messageID, part);
    const session = adapter.session.get(part.sessionID);
    if (session) {
      Bus.publish(Event.Updated, { info: session });
    }
  }

  export function getParts(messageID: string): Message.Part[] {
    return Storage.getAdapter().part.list(messageID);
  }

  export async function suspend(id: string): Promise<boolean> {
    return get(id) !== undefined;
  }

  export async function resume(id: string): Promise<RecoveredMessage[]> {
    const recovered: RecoveredMessage[] = [];
    let sequence = 1;

    for (const message of getMessages(id)) {
      if (message.role !== "assistant") {
        continue;
      }
      const text = getParts(message.id)
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text.length === 0) continue;

      recovered.push({
        role: "assistant",
        text,
        timestamp: new Date(message.time.created).toISOString(),
        sequence,
        turnIndex: sequence - 1,
      });
      sequence += 1;
    }

    return recovered;
  }

  export async function abandon(id: string): Promise<boolean> {
    return remove(id);
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
