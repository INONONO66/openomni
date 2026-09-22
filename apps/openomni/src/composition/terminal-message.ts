import { Effect, FiberRef } from "effect";
import { Bus, createExecutor, ForeignFailure, type SessionRuntime } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import type { GatewayRouter } from "@openomni/channels";
import type { LedgerAction } from "@openomni/protocol";

type OutboundInput = Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0];
interface OutboundContext {
  readonly input: OutboundInput;
  readonly executor: ReturnType<typeof createExecutor>;
  receipt?: LedgerAction.Receipt;
}

export const outboundMessage = FiberRef.unsafeMake<OutboundContext | undefined>(undefined);

/** The gateway admits recorded bytes; the receiver, not this source, owns its inbox. */
export function dispatchOutboundMessage(
  ingest: GatewayRouter["ingest"],
  clock: () => number,
): NonNullable<SessionRuntime["dispatchOutbound"]> {
  return (input) => Effect.gen(function* () {
    const { message, authority, policy } = input;
    const executor = createExecutor({
      identity: {
        sessionId: message.sourceSessionId,
        role: SessionHandleStore.row(message.sourceSessionId).role,
        parentActionId: `${message.sourceActionId}:outbound`,
      },
      policy,
      observations: Bus,
      clock,
      entropy: () => crypto.randomUUID(),
      ledger: {
        commit: (action) => Effect.gen(function* () {
          const row = SessionHandleStore.row(message.sourceSessionId);
          const result = yield* SessionHandleStore.commit({
            sessionId: message.sourceSessionId, ...authority, now: clock(),
            expectedRevision: row.revision, actions: [action], consumeInboxIds: [], state: row.state, releaseLease: false,
          });
          const receipt = result.receipts[0];
          if (receipt === undefined) throw new Error("outbound policy receipt missing");
          return receipt;
        }),
      },
    });
    const context: OutboundContext = { input, executor };
    return yield* Effect.gen(function* () {
      const admitted = yield* ingest(
        { kind: "session", id: message.sourceSessionId },
        {
          to: { kind: "session", id: message.destinationSessionId },
          type: "message",
          content: message.content,
          replyTo: message.replyTo,
        },
      );
      if (admitted.status === "blocked_pre") throw new Error("outbound gateway admission refused");
      const receipt =
        context.receipt ??
        SessionHandleStore.outboundReceipt(message.destinationSessionId, message.messageId);
      if (receipt === undefined)
        throw new Error("outbound receiving consumer did not commit a receipt");
      return receipt;
    }).pipe(
      Effect.locally(outboundMessage, context),
      Effect.mapError((error) => new ForeignFailure({ operation: "message.outbound", cause: String(error) })),
    );
  });
}
