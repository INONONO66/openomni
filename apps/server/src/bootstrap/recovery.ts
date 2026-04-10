import type { Adapter } from "@openomni/protocol";
import { recoverInterruptedMessages, type RecoveryItem } from "../recovery";

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Adapter.MessageHandler,
): Promise<void> {
  console.log(`[recovery] Processing ${queue.length} retry item(s)...`);

  for (const item of queue) {
    try {
      await handler({
        id: item.messageId,
        surfaceKey: item.surfaceKey,
        text: item.text,
        sender: { id: "recovery", name: "recovery" },
      });
    } catch (err) {
      console.error(`[recovery] Retry failed for ${item.messageId}:`, err);
    }
  }

  console.log("[recovery] Retry processing complete");
}

export async function runRecovery(handler: Adapter.MessageHandler | undefined): Promise<void> {
  const retryQueue = await recoverInterruptedMessages();
  if (handler && retryQueue.length > 0) {
    await processRetryQueue(retryQueue, handler);
  } else if (retryQueue.length > 0) {
    console.warn(`[recovery] ${retryQueue.length} message(s) need retry but no handler available`);
  }
}
