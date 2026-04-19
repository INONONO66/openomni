import type { Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus, Log } from "@openomni/session";
import { recoverInterruptedMessages, type RecoveryItem } from "../recovery";

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Adapter.MessageHandler,
): Promise<void> {
  Log.info(`recovery processing ${queue.length} retry item(s)`);

  for (const item of queue) {
    try {
      await handler({
        id: item.messageId,
        surfaceKey: item.surfaceKey,
        text: item.text,
        sender: { id: "recovery", name: "recovery" },
      });
    } catch (err) {
      Log.error(`recovery retry failed for ${item.messageId}`, { err: String(err) });
    }
  }

  Log.info("recovery retry processing complete");
}

export async function runRecovery(
  handler: Adapter.MessageHandler | undefined,
  coordinator?: { recoverInterruptedRuns(): Promise<unknown> },
  traceId?: string,
): Promise<void> {
  const startTime = Date.now();
  const id = traceId ?? crypto.randomUUID();

  Bus.publish(Operational.RecoveryStarted, {
    traceId: id,
    time: startTime,
  });

  let sessionsRecovered = 0;
  try {
    const recoveryResult = await coordinator?.recoverInterruptedRuns();
    sessionsRecovered = typeof recoveryResult === "number" ? recoveryResult : 0;

    const retryQueue = await recoverInterruptedMessages();
    if (handler && retryQueue.length > 0) {
      await processRetryQueue(retryQueue, handler);
    } else if (retryQueue.length > 0) {
      Log.warn(`recovery ${retryQueue.length} message(s) need retry but no handler available`);
    }
  } finally {
    const durationMs = Date.now() - startTime;
    Bus.publish(Operational.RecoveryCompleted, {
      traceId: id,
      sessionsRecovered,
      durationMs,
      time: Date.now(),
    });
  }
}
