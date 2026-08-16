import type { Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage";
import { Event } from "./events";

export function addMessage(
  sessionID: string,
  message: Message.Info,
  options?: { status?: "received" | "processing" | "completed" },
): void {
  const adapter = Storage.getAdapter();
  const session = adapter.session.get(sessionID);
  if (!session) {
    // Fail closed: ingress appends its message.write ledger fact BEFORE this
    // call — returning silently here left record-without-act with zero
    // telemetry (unexplained message loss the ledger claims happened).
    throw new Error(`addMessage: session not found: ${sessionID}`);
  }

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
