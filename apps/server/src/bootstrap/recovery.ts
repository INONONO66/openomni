import type { Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { WaitService, type DefaultDispatchRuntime } from "@openomni/openomni";
import { Bus, PendingInteractionStore } from "@openomni/session";
import { recoverInterruptedMessages, type RecoveryItem } from "../recovery";

async function processRetryQueue(
  queue: RecoveryItem[],
  handler: Adapter.MessageHandler,
): Promise<void> {
  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: `recovery processing ${queue.length} retry item(s)`,
  });

  for (const item of queue) {
    try {
      await handler({
        id: item.messageId,
        surfaceKey: item.surfaceKey,
        text: item.text,
        sender: { id: "recovery", name: "recovery" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: `recovery retry failed for ${item.messageId}`,
        context: { err: message },
      });
    }
  }

  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "recovery retry processing complete",
  });
}

export type BootstrapRecoveryInput = Readonly<{
  handler: Adapter.MessageHandler | undefined;
  coordinator?: { recoverInterruptedRuns(): Promise<{ recovered: number; sessions: string[] }> };
  traceId?: string;
  completionRuntime: Pick<DefaultDispatchRuntime, "recoverRecordedWorkItemCompletions">;
}>;

type InboundSurface = Readonly<{ start(): Promise<void> | void }>;

export async function startInboundSurfacesAfterRecovery<T>(
  input: Readonly<{
    recover(): Promise<void>;
    createServer(): T;
    channels: readonly InboundSurface[];
  }>,
): Promise<T> {
  await input.recover();
  const server = input.createServer();
  await Promise.all(input.channels.map((channel) => channel.start()));
  return server;
}

export async function runRecovery(input: BootstrapRecoveryInput): Promise<void> {
  const { handler, coordinator, traceId, completionRuntime: completionRecovery } = input;
  const startTime = Date.now();
  const id = traceId ?? crypto.randomUUID();

  Bus.publish(Operational.RecoveryStarted, {
    traceId: id,
    time: startTime,
  });

  let sessionsRecovered = 0;
  try {
    const recoveryResult = await coordinator?.recoverInterruptedRuns();
    sessionsRecovered = recoveryResult?.sessions.length ?? 0;
    if (completionRecovery) {
      try {
        const receipt = await completionRecovery.recoverRecordedWorkItemCompletions();
        Bus.publish(receipt.failures.length > 0 ? Operational.Error : Operational.Info, {
          traceId: id,
          time: Date.now(),
          component: "server",
          msg: `recovery resumed ${receipt.recovered} recorded WorkItem completion(s)`,
          context: {
            skipped: receipt.skipped,
            failures: receipt.failures,
          },
        });
      } catch (error) {
        Bus.publish(Operational.Error, {
          traceId: id,
          time: Date.now(),
          component: "server",
          msg: "recovery failed to resume recorded WorkItem completions",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    const expiredPendingInteractions = PendingInteractionStore.cleanupExpired();
    if (expiredPendingInteractions.length > 0) {
      Bus.publish(Operational.Info, {
        traceId: id,
        time: Date.now(),
        component: "server",
        msg: `recovery expired ${expiredPendingInteractions.length} pending interaction(s)`,
      });
    }
    const expiredWaits = WaitService.sweepExpired();
    if (expiredWaits.length > 0) {
      Bus.publish(Operational.Info, {
        traceId: id,
        time: Date.now(),
        component: "server",
        msg: `recovery expired ${expiredWaits.length} wait(s)`,
      });
    }

    const retryQueue = await recoverInterruptedMessages();
    if (handler && retryQueue.length > 0) {
      await processRetryQueue(retryQueue, handler);
    } else if (retryQueue.length > 0) {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: `recovery ${retryQueue.length} message(s) need retry but no handler available`,
      });
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
