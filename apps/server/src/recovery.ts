import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export interface InterruptedMessageProjection {
  readonly sessionId: string;
  readonly messageId: string;
}

export interface MessageRecoveryService {
  readonly queries: {
    interruptedMessages(): Promise<readonly InterruptedMessageProjection[]>;
  };
  readonly commands: {
    reconcileInterruptedMessage(input: {
      readonly sessionId: string;
      readonly messageId: string;
      readonly requestId: string;
    }): Promise<"recovered" | "unchanged">;
  };
}

export interface MessageRecoveryResult {
  readonly recovered: number;
  readonly examined: number;
}

/** Never throws — server boot must not fail due to recovery errors. */
export async function recoverInterruptedMessages(
  service: MessageRecoveryService,
): Promise<MessageRecoveryResult> {
  const traceId = crypto.randomUUID();
  Bus.publish(Operational.Info, {
    traceId,
    time: Date.now(),
    component: "server",
    msg: "checking for interrupted messages",
  });

  try {
    const interrupted = await service.queries.interruptedMessages();
    let recovered = 0;

    for (const item of interrupted) {
      try {
        const outcome = await service.commands.reconcileInterruptedMessage({
          sessionId: item.sessionId,
          messageId: item.messageId,
          requestId: `message-recovery:${item.messageId}`,
        });
        if (outcome === "recovered") recovered += 1;
      } catch {
        Bus.publish(Operational.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "message reconciliation failed",
          context: {
            messageId: item.messageId,
            reconciliationFailed: true,
          },
        });
      }
    }

    Bus.publish(Operational.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "message recovery done",
      context: { recovered, examined: interrupted.length },
    });
    return { recovered, examined: interrupted.length };
  } catch {
    Bus.publish(Operational.Error, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "message recovery query failed",
      context: { recoveryQueryFailed: true },
    });
    return { recovered: 0, examined: 0 };
  }
}
