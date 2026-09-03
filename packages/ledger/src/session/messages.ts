import type { Message } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { Event } from "./events";

export function addMessage(
  sessionID: string,
  message: Message.Info,
  options?: { status?: "received" | "processing" | "completed" },
): void {
  const adapter = Storage.get();
  const session = adapter.session.get(sessionID);
  if (!session) {
    // Fail closed: ingress appends its message.write ledger fact BEFORE this
    // call — returning silently here left record-without-act with zero
    // telemetry (unexplained message loss the ledger claims happened).
    throw new Error(`addMessage: session not found: ${sessionID}`);
  }

  const status = options?.status ?? "completed";

  // The counter update below is get→mutate→set without a CAS, and the read
  // above runs BEFORE the transaction — its safety rests entirely on session
  // rows having exactly one writer process (server ingress + dispatch;
  // worker processes write only message/part). A second
  // session-row writer requires a revision column + CAS, per the
  // wait/work-item precedent. The transaction makes the three writes one
  // fsync unit; it does not protect the read.
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

  adapter.transaction(() => {
    adapter.message.set(sessionID, message);
    if (status !== "completed" && adapter.message.setStatus) {
      adapter.message.setStatus(message.id, status);
    }
    adapter.session.set(sessionID, updated);
  });
  // Published after the top-level commit. Do not wrap addMessage in an outer
  // transaction: this publish would fire at savepoint release, announcing a
  // write the outer transaction can still roll back.
  Storage.publishObservation(Event.Updated, { info: updated });
}

// Publishes nothing: status flips are recovery bookkeeping, not the
// ingress-tier "session content changed" notification Event.Updated carries.
export function updateMessageStatus(
  messageID: string,
  status: "received" | "processing" | "completed",
): void {
  const adapter = Storage.get();
  if (adapter.message.setStatus) {
    adapter.message.setStatus(messageID, status);
  }
}

export function getMessages(sessionID: string): Message.Info[] {
  return Storage.get().message.list(sessionID);
}

export function addPart(messageID: string, part: Message.Part): void {
  const adapter = Storage.get();
  const session = adapter.session.get(part.sessionID);
  if (!session) {
    // Fail closed like addMessage: a part for a missing session is a defect
    // upstream, not a condition to absorb silently.
    throw new Error(`addPart: session not found: ${part.sessionID}`);
  }
  adapter.part.set(messageID, part);
  Storage.publishObservation(Event.Updated, { info: session });
}

export function getParts(messageID: string): Message.Part[] {
  return Storage.get().part.list(messageID);
}
