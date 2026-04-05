import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";

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

  console.log("[recovery] Checking for interrupted messages...");

  try {
    const adapter = Storage.get();
    const processing = adapter.message.findByStatus?.("processing") ?? [];
    const received = adapter.message.findByStatus?.("received") ?? [];
    const interrupted = [...processing, ...received];

    if (interrupted.length === 0) {
      console.log("[recovery] No interrupted messages found.");
      return retryQueue;
    }

    console.log(
      `[recovery] Found ${interrupted.length} interrupted message(s) (${processing.length} processing, ${received.length} received)`,
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
          console.log(
            `[recovery] Marked message ${messageId} as completed (assistant response exists)`,
          );
          continue;
        }

        const session = Session.get(sessionId);
        if (!session) {
          console.warn(`[recovery] Session ${sessionId} not found, skipping message ${messageId}`);
          Session.updateMessageStatus(messageId, "received");
          continue;
        }

        const parts = Session.getParts(messageId);
        const textPart = parts.find((p): p is Message.TextPart => p.type === "text");

        if (!textPart?.text) {
          console.warn(`[recovery] No text found for message ${messageId}, skipping retry`);
          Session.updateMessageStatus(messageId, "received");
          continue;
        }

        retryQueue.push({
          sessionId,
          messageId,
          surfaceKey: session.title,
          text: textPart.text,
          resumeExisting: true,
        });
        console.log(`[recovery] Queued message ${messageId} for retry`);
      } catch (err) {
        console.error(`[recovery] Error processing message ${messageId}:`, err);
      }
    }

    console.log(
      `[recovery] Done: ${recovered} recovered, ${retryQueue.length} queued for retry, ${processing.length} total`,
    );
  } catch (err) {
    console.error("[recovery] Recovery failed:", err);
  }

  return retryQueue;
}
