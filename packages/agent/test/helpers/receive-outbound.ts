import { Effect, Either } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";

/** Lands an outbound message in the destination's inbox exactly as a live dispatcher would. */
export function receiveOutbound(message: SessionTransition.OutboundMessage, createdAt: number) {
  return Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.commitReceivedMessage({
          id: message.messageId,
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt,
          parentActionId: null,
        }),
      ),
    ),
    (error) => error,
  );
}
