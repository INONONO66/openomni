import { Session, Storage } from "@openomni/session";

/** Never throws — server boot must not fail due to recovery errors. */
export async function recoverInterruptedMessages(): Promise<void> {
  console.log("[recovery] Checking for interrupted messages...");

  try {
    const adapter = Storage.get();
    const processing = adapter.message.findByStatus?.("processing") ?? [];

    if (processing.length === 0) {
      console.log("[recovery] No interrupted messages found.");
      return;
    }

    console.log(`[recovery] Found ${processing.length} message(s) with status=processing`);

    let recovered = 0;
    let needsRetry = 0;

    for (const { id: messageId, sessionId } of processing) {
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
        } else {
          Session.updateMessageStatus(messageId, "received");
          needsRetry++;
          console.warn(
            `[recovery] Message ${messageId} in session ${sessionId} needs retry (no response found)`,
          );
        }
      } catch (err) {
        console.error(`[recovery] Error processing message ${messageId}:`, err);
      }
    }

    console.log(
      `[recovery] Done: ${recovered} recovered, ${needsRetry} need retry, ${processing.length} total`,
    );
  } catch (err) {
    console.error("[recovery] Recovery failed:", err);
  }
}
