import type { Message } from "@openomni/protocol";
import { Bus } from "../bus";
import { Storage } from "../storage/storage";
import { Event } from "./events";
import { TranscriptStore } from "./transcript";

type RecoveredMessage = {
  role: "assistant";
  text: string;
  timestamp: string;
  sequence: number;
  turnIndex: number;
};

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

  const updated = {
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

export async function resume(id: string): Promise<RecoveredMessage[]> {
  // #547 C3: resume replays the persisted Transcript.Fact stream through the
  // fold — the message/part tables are read-model projections of it, never
  // the record. Sessions with an empty fact stream (history recorded before
  // the transcript record family, or projection-only writers like ingress)
  // fall back to the projection read.
  const replayed = TranscriptStore.replay(id);
  const source = replayed.length > 0 ? replayed : await hydrateMessages(getMessages(id));

  const recovered: RecoveredMessage[] = [];
  let sequence = 1;

  for (const message of source) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const text = message.parts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length === 0) continue;

    recovered.push({
      role: "assistant",
      text,
      timestamp: new Date(message.info.time.created).toISOString(),
      sequence,
      turnIndex: sequence - 1,
    });
    sequence += 1;
  }

  return recovered;
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
