import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { recoverInterruptedRuns, type RunRecoveryService } from "../execution/recovery";
import type { MessageRecoveryService } from "../recovery";

export interface RecoveryServices {
  readonly messages: MessageRecoveryService;
  readonly runs: RunRecoveryService;
}

export async function runRecovery(services: RecoveryServices, traceId?: string): Promise<void> {
  const startTime = Date.now();
  const id = traceId ?? crypto.randomUUID();

  Bus.publish(Operational.RecoveryStarted, {
    traceId: id,
    time: startTime,
  });

  let sessionsRecovered = 0;
  try {
    const runRecovery = await recoverInterruptedRuns(services.runs);
    sessionsRecovered = runRecovery.sessions.length;
    for (const message of await services.messages.queries.interruptedMessages()) {
      await services.messages.commands.reconcileInterruptedMessage({
        sessionId: message.sessionId,
        messageId: message.messageId,
        requestId: `message-recovery:${message.messageId}`,
      });
    }
  } catch (error) {
    Bus.publish(Operational.Error, {
      traceId: id,
      time: Date.now(),
      component: "server",
      msg: "recovery failed",
      context: { recoveryFailed: true },
    });
    throw error;
  }
  Bus.publish(Operational.RecoveryCompleted, {
    traceId: id,
    sessionsRecovered,
    durationMs: Date.now() - startTime,
    time: Date.now(),
  });
}
