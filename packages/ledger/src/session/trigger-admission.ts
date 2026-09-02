import type { Message } from "@openomni/protocol";
import { Trigger } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage";
import { Event } from "./events";
import type { SessionInfo } from "./info";

export interface InternalTriggerAdmissionInput {
  readonly sessionId: string;
  readonly fireId: string;
  readonly payload: string;
  readonly payloadDigest: Trigger.CanonicalDigest;
  readonly admittedAt: number;
}

/**
 * Deterministic message id for a Fire. A redelivered Fire therefore addresses
 * the same message row, which is what makes admission idempotent without a
 * separate dedupe index.
 */
function admissionMessageId(fireId: string): string {
  return `trigger-fire:${fireId}`;
}

function admissionPartId(messageId: string): string {
  return `${messageId}:text`;
}

function ownerMissing(input: InternalTriggerAdmissionInput): never {
  throw new Trigger.StoreError({
    code: "owner_session_missing",
    fireId: input.fireId,
    message: `Trigger Fire owner session is gone: ${input.sessionId}`,
  });
}

function conflict(input: InternalTriggerAdmissionInput, detail: string): never {
  throw new Trigger.StoreError({
    code: "admission_conflict",
    fireId: input.fireId,
    message: `Trigger Fire admission conflicts with an existing message: ${detail}`,
  });
}

function buildAdmissionMessage(
  input: InternalTriggerAdmissionInput,
  messageId: string,
  session: SessionInfo,
): Message.Info {
  return {
    id: messageId,
    sessionID: input.sessionId,
    role: "user",
    time: { created: input.admittedAt },
    agent: "system",
    model: session.model,
    system: "trigger.fire",
  };
}

function buildAdmissionPart(
  input: InternalTriggerAdmissionInput,
  messageId: string,
): Message.TextPart {
  return {
    id: admissionPartId(messageId),
    sessionID: input.sessionId,
    messageID: messageId,
    type: "text",
    text: input.payload,
  };
}

/**
 * Admits one durable Trigger Fire into its OWNER session's transcript.
 *
 * Owner-only by construction: a Fire whose session is absent OR already past
 * its expiry at the admission instant is refused rather than resurrected.
 * Materializing (or writing into) a closed transcript would give a Trigger the
 * power to revive sessions and would deliver the Fire into a conversation its
 * author never saw. Expiry is judged at `admittedAt`, not at read time, so a
 * concurrent sweep and this write agree on one boundary.
 *
 * Returns only after the message AND its text part are durable in one
 * transaction, so an acknowledged Fire can never leave a wake with an empty
 * transcript behind. A retry that finds the deterministic message from an
 * interrupted earlier attempt completes the missing part instead of accepting
 * a contentless turn; a message that disagrees about owner, marker, or payload
 * is a typed conflict, never a silent repair.
 */
export function admitInternalTrigger(
  input: InternalTriggerAdmissionInput,
): Trigger.FireAdmission {
  const adapter = Storage.get();
  const session = adapter.session.get(input.sessionId);
  // Same boundary Session.get applies, evaluated at the admission instant.
  if (!session || (session.expiresAt !== undefined && input.admittedAt > session.expiresAt)) {
    ownerMissing(input);
  }

  const messageId = admissionMessageId(input.fireId);
  const receipt = Trigger.FireAdmission.parse({
    fireId: input.fireId,
    sessionId: input.sessionId,
    messageId,
    payloadDigest: input.payloadDigest,
    admittedAt: input.admittedAt,
  });

  // Queried by global message ID, not only within the requested session: a
  // deterministic ID owned by another session is a conflict, not an absence.
  const existing = adapter.message.get(input.sessionId, messageId);
  if (existing !== undefined) {
    if (existing.role !== "user" || existing.system !== "trigger.fire") {
      conflict(input, `${messageId} is not a Trigger admission message`);
    }
    // Parts are addressed by the global message ID, so a row belonging to any
    // other session surfaces here rather than being silently overwritten.
    const parts = adapter.part.list(messageId);
    if (parts.length > 1) conflict(input, `${messageId} has ${parts.length} parts`);
    const part = parts[0];
    if (part !== undefined) {
      if (part.sessionID !== input.sessionId) {
        conflict(input, `${messageId} belongs to session ${part.sessionID}`);
      }
      if (part.type !== "text" || part.text !== input.payload) {
        conflict(input, `${messageId} carries a different payload`);
      }
      return receipt;
    }
    // The crash window: the message committed, its content did not. Acking
    // here would ack an empty wake, so the part is completed first.
    adapter.transaction(() => {
      adapter.part.set(messageId, buildAdmissionPart(input, messageId));
    });
    Bus.publish(Event.Updated, { info: session });
    return receipt;
  }

  const updatedSession: SessionInfo = {
    ...session,
    messageCount: (session.messageCount ?? 0) + 1,
    time: {
      ...session.time,
      updated: Math.max(session.time.updated, input.admittedAt),
    },
  };

  // One unit: message, part, and the session projection commit together, so no
  // crash can expose a message without its payload.
  adapter.transaction(() => {
    adapter.message.set(input.sessionId, buildAdmissionMessage(input, messageId, session));
    adapter.part.set(messageId, buildAdmissionPart(input, messageId));
    adapter.session.set(input.sessionId, updatedSession);
  });
  // Exactly one content notification per admission, published after commit.
  Bus.publish(Event.Updated, { info: updatedSession });

  return receipt;
}
