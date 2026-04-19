import type { Message } from "@openomni/protocol";
import { Session, Storage, SurfaceKey, Log } from "@openomni/session";

export interface RecoveryItem {
  sessionId: string;
  messageId: string;
  surfaceKey: string;
  text: string;
  resumeExisting: true;
}

/** Never throws — server boot must not fail due to recovery errors. */
export async function recoverInterruptedMessages(): Promise<RecoveryItem[]> {
  const retryQueue: RecoveryItem[] = [];

  Log.info("recovery checking for interrupted messages");

  try {
    const adapter = Storage.get();
    const processing = adapter.message.findByStatus?.("processing") ?? [];
    const received = adapter.message.findByStatus?.("received") ?? [];
    const interrupted = [...processing, ...received];

    if (interrupted.length === 0) {
      Log.info("recovery no interrupted messages found");
      return retryQueue;
    }

    Log.info(
      `recovery found ${interrupted.length} interrupted message(s) (${processing.length} processing, ${received.length} received)`,
    );

    let recovered = 0;

    for (const { id: messageId, sessionId } of interrupted) {
      try {
        const messages = Session.getMessages(sessionId);
        const msgIndex = messages.findIndex((m) => m.id === messageId);

        const hasAssistantAfter =
          msgIndex >= 0 && messages.slice(msgIndex + 1).some((m) => m.role === "assistant");

        if (hasAssistantAfter) {
          Session.updateMessageStatus(messageId, "completed");
          recovered++;
          Log.info(`recovery marked message ${messageId} as completed (assistant response exists)`);
          continue;
        }

        const session = Session.get(sessionId);
        if (!session) {
          Log.warn(`recovery session ${sessionId} not found, skipping message ${messageId}`);
          Session.updateMessageStatus(messageId, "received");
          continue;
        }

        const parts = Session.getParts(messageId);
        const textPart = parts.find((p): p is Message.TextPart => p.type === "text");

        if (!textPart?.text) {
          Log.warn(`recovery no text found for message ${messageId}, skipping retry`);
          Session.updateMessageStatus(messageId, "received");
          continue;
        }

        // Prefer the registered surfaceKey mapping (in-memory). Fall back to
        // session.title which conversation.ts always sets to the surfaceKey.
        const registeredKeys = SurfaceKey.listBySession(sessionId);
        const surfaceKey = registeredKeys[0] ?? session.title;

        retryQueue.push({
          sessionId,
          messageId,
          surfaceKey,
          text: textPart.text,
          resumeExisting: true,
        });
        Log.info(`recovery queued message ${messageId} for retry`);
      } catch (err) {
        Log.error(`recovery error processing message ${messageId}`, { err: String(err) });
      }
    }

    Log.info(
      `recovery done: ${recovered} recovered, ${retryQueue.length} queued for retry, ${processing.length} total`,
    );
  } catch (err) {
    Log.error("recovery recovery failed", { err: String(err) });
  }

  return retryQueue;
}
