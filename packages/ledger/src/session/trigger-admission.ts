import { Trigger } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { addMessage, addPart, getMessages } from "./messages";

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

/**
 * Admits one durable Trigger Fire into its OWNER session's transcript.
 *
 * Owner-only by construction: a Fire whose session no longer exists is refused
 * rather than resurrected, because materializing a replacement here would give
 * a Trigger the power to create sessions and would deliver the Fire into a
 * transcript its author never saw.
 *
 * Returns only after the message and its text part are durable, so the caller
 * can acknowledge the Fire knowing a crash cannot lose the admission it just
 * promised. Re-admitting the same Fire returns the original receipt untouched.
 */
export function admitInternalTrigger(
  input: InternalTriggerAdmissionInput,
): Trigger.FireAdmission {
  const adapter = Storage.get();
  const session = adapter.session.get(input.sessionId);
  if (!session) {
    throw new Trigger.StoreError({
      code: "owner_session_missing",
      fireId: input.fireId,
      message: `Trigger Fire owner session is gone: ${input.sessionId}`,
    });
  }

  const messageId = admissionMessageId(input.fireId);
  const receipt = Trigger.FireAdmission.parse({
    fireId: input.fireId,
    sessionId: input.sessionId,
    messageId,
    payloadDigest: input.payloadDigest,
    admittedAt: input.admittedAt,
  });

  // A redelivery finds its own admission already recorded and reuses it, so a
  // Fire that crashed between admission and acknowledgement is never told twice.
  if (getMessages(input.sessionId).some((message) => message.id === messageId)) {
    return receipt;
  }

  addMessage(input.sessionId, {
    id: messageId,
    sessionID: input.sessionId,
    role: "user",
    time: { created: input.admittedAt },
    agent: "system",
    model: { providerID: "trigger", modelID: "trigger" },
    system: "trigger.fire",
  });
  addPart(messageId, {
    id: `${messageId}:text`,
    sessionID: input.sessionId,
    messageID: messageId,
    type: "text",
    text: input.payload,
  });

  return receipt;
}
