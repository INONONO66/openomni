import type { Message } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Session, Storage, SurfaceKey } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

export interface RecoveryItem {
  sessionId: string;
  messageId: string;
  surfaceKey: string;
  text: string;
  resumeExisting: true;
}

/**
 * Never throws — server boot must not fail due to recovery errors.
 * `traceId` is the boot recovery's: this sweep is mid-flow, not a trace
 * origin, so every line it emits inherits the caller's chain.
 */
export async function recoverInterruptedMessages(traceId: string): Promise<RecoveryItem[]> {
  const retryQueue: RecoveryItem[] = [];

  Bus.publish(Operational.Events.Info, {
    traceId,
    time: Date.now(),
    component: "server",
    msg: "checking for interrupted messages",
  });

  try {
    const adapter = Storage.get();
    if (adapter.message.findByStatus === undefined) {
      // "No interrupted messages" and "cannot ask" are different answers:
      // the throw lands in this function's own catch below, which records a
      // loud recovery Error — boot still proceeds (never refuses boot, same
      // stance as the ledger walk in bootstrap/recovery).
      throw new Error("message adapter does not implement findByStatus");
    }
    const processing = adapter.message.findByStatus("processing");
    const received = adapter.message.findByStatus("received");
    const interrupted = [...processing, ...received];

    if (interrupted.length === 0) {
      Bus.publish(Operational.Events.Info, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "no interrupted messages found",
      });
      return retryQueue;
    }

    Bus.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "found interrupted messages",
      context: {
        total: interrupted.length,
        processing: processing.length,
        received: received.length,
      },
    });

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
          Bus.publish(Operational.Events.Info, {
            traceId,
            time: Date.now(),
            component: "server",
            msg: "marked message as completed",
            context: { messageId },
          });
          continue;
        }

        const session = Session.get(sessionId);
        if (!session) {
          Bus.publish(Operational.Events.Warn, {
            traceId,
            time: Date.now(),
            component: "server",
            msg: "session not found, skipping message",
            context: { sessionId, messageId },
          });
          Session.updateMessageStatus(messageId, "received");
          continue;
        }

        const parts = Session.getParts(messageId);
        const textPart = parts.find((p): p is Message.TextPart => p.type === "text");

        if (!textPart?.text) {
          Bus.publish(Operational.Events.Warn, {
            traceId,
            time: Date.now(),
            component: "server",
            msg: "no text found for message, skipping retry",
            context: { messageId },
          });
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
        Bus.publish(Operational.Events.Info, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "queued message for retry",
          context: { messageId },
        });
      } catch (err) {
        Bus.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "error processing message",
          context: { messageId, err: String(err) },
        });
      }
    }

    Bus.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "recovery done",
      context: { recovered, queued: retryQueue.length, total: processing.length },
    });
  } catch (err) {
    Bus.publish(Operational.Events.Error, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "recovery failed",
      context: { err: String(err) },
    });
  }

  return retryQueue;
}
