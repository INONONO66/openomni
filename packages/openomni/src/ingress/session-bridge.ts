import type { Model } from "@openomni/protocol";
import {
  MessagingLedgerServiceError,
  requireCommittedMessagingTransition,
  requireMessagingLedgerService,
} from "./session-resolver";

export namespace SessionBridge {
  export async function buildDirectMessages(
    sessionId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const projection = await requireMessagingLedgerService().query({
      kind: "transcript",
      sessionId,
    });
    if (projection.kind !== "transcript") {
      throw new MessagingLedgerServiceError("messaging_projection_invalid");
    }

    const result: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const message of projection.messages) {
      for (const part of message.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          result.push({ role: message.role, content: part.text });
        }
      }
    }
    return result;
  }

  export async function storeDirectResult(
    sessionId: string,
    output: string,
    model: Model.Ref,
  ): Promise<void> {
    requireCommittedMessagingTransition(
      await requireMessagingLedgerService().execute({
        kind: "MS-06",
        sessionId,
        messageId: crypto.randomUUID(),
        partId: crypto.randomUUID(),
        role: "assistant",
        text: output,
        model,
        agent: "session-bridge",
        recordedAt: Date.now(),
      }),
    );
  }
}
