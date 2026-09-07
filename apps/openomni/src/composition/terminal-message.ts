import { AsyncLocalStorage } from "node:async_hooks";
import { Bus, createExecutor, type SessionRuntime } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import type { GatewayRouter } from "@openomni/channels";
import { SessionTransition, type LedgerAction } from "@openomni/protocol";

type OutboundInput = Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0];
interface OutboundContext {
  readonly input: OutboundInput;
  readonly executor: ReturnType<typeof createExecutor>;
  receipt?: LedgerAction.Receipt;
}

export const outboundMessage = new AsyncLocalStorage<OutboundContext>();

function receivedOutbound(
  message: SessionTransition.OutboundMessage,
): LedgerAction.Receipt | undefined {
  const action = SessionHandleStore.tree(message.destinationSessionId).find((candidate) => {
    if (candidate.id === message.messageId && candidate.kind === "prompt") return true;
    if (candidate.kind !== "reply") return false;
    const effect = candidate.effect.value;
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return false;
    const answer = SessionTransition.Answer.safeParse(effect.answer);
    return answer.success && answer.data.outbound?.messageId === message.messageId;
  });
  return action === undefined ? undefined : { action, revision: action.ordinal };
}

/** The gateway admits recorded bytes; the receiver, not this source, owns its inbox. */
export function dispatchOutboundMessage(
  ingest: GatewayRouter["ingest"],
  clock: () => number,
): NonNullable<SessionRuntime["dispatchOutbound"]> {
  return async (input) => {
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
        async commit(action) {
          const row = SessionHandleStore.row(message.sourceSessionId);
          const result = SessionHandleStore.commit({
            sessionId: message.sourceSessionId,
            ...authority,
            now: clock(),
            expectedRevision: row.revision,
            actions: [action],
            consumeInboxIds: [],
            state: row.state,
            releaseLease: false,
          });
          if (!result.ok) throw new Error(`outbound policy commit ${result.reason}`);
          const receipt = result.receipts[0];
          if (receipt === undefined) throw new Error("outbound policy receipt missing");
          return receipt;
        },
      },
    });
    const context: OutboundContext = { input, executor };
    return outboundMessage.run(context, async () => {
      const admitted = await ingest(
        { kind: "session", id: message.sourceSessionId },
        {
          to: { kind: "session", id: message.destinationSessionId },
          type: "message",
          content: message.content,
          replyTo: message.replyTo,
        },
      );
      if (admitted.status === "blocked_pre") throw new Error("outbound gateway admission refused");
      const receipt = context.receipt ?? receivedOutbound(message);
      if (receipt === undefined)
        throw new Error("outbound receiving consumer did not commit a receipt");
      return receipt;
    });
  };
}
